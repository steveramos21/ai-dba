import { describe, it, expect, vi } from "vitest";
import { parseMongoUrl, MongoDbConnector } from "./mongodb.js";
import type { EngineConfig } from "../config.js";

describe("parseMongoUrl", () => {
  it("extracts database from URL", () => {
    const r = parseMongoUrl("mongodb://user:pass@10.0.0.1:27017/mydb");
    expect(r.database).toBe("mydb");
    expect(r.uri).toBe("mongodb://user:pass@10.0.0.1:27017/mydb");
  });

  it("defaults to admin when no database in path", () => {
    const r = parseMongoUrl("mongodb://user:pass@host:27017");
    expect(r.database).toBe("admin");
  });

  it("handles mongodb+srv:// scheme", () => {
    const r = parseMongoUrl("mongodb+srv://user:pass@cluster.example.com/mydb?authSource=admin");
    expect(r.database).toBe("mydb");
  });

  it("throws on invalid URL", () => {
    expect(() => parseMongoUrl("not-a-url")).toThrow("Invalid MongoDB URL");
  });
});

describe("MongoDbConnector — row cap (Task 1.2)", () => {
  function setupCap(docs: Record<string, unknown>[]) {
    const connector = new MongoDbConnector();
    const toArray = vi.fn().mockResolvedValue(docs);
    const limit = vi.fn().mockReturnValue({ toArray });
    const find = vi.fn().mockReturnValue({ limit });
    const collection = vi.fn().mockReturnValue({ find });
    const client = { db: vi.fn().mockReturnValue({ collection }) };
    // @ts-expect-error - we're mocking the private client cache
    connector.clients.set("cap-engine", client);
    const config: EngineConfig = { type: "mongodb", url: "mongodb://u:p@localhost:27017/db", rowLimit: 2 };
    return { connector, find, limit, config };
  }

  it("limits find to cap+1 server-side and flags truncation when the extra doc arrives", async () => {
    const { connector, limit, config } = setupCap([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

    const result = await connector.query("cap-engine", config, JSON.stringify({ find: "c" }));

    expect(limit).toHaveBeenCalledWith(3);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.rowCap).toBe(2);
  });

  it("does not flag truncation when docs are at or under the cap", async () => {
    const { connector, config } = setupCap([{ _id: 1 }, { _id: 2 }]);

    const result = await connector.query("cap-engine", config, JSON.stringify({ find: "c" }));

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
    expect(result.rowCap).toBeUndefined();
  });

  it("honours a caller limit at or below the cap", async () => {
    const { connector, limit, config } = setupCap([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

    await connector.query("cap-engine", config, JSON.stringify({ find: "c", limit: 1 }));

    // A caller limit of 1 is honoured as-is: fetch 1 doc, no way to prove
    // truncation beyond it, so the server fetch is bounded at min(1, cap+1).
    expect(limit).toHaveBeenCalledWith(1);
  });
});