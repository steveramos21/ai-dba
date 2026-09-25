import { describe, it, expect, vi } from "vitest";
import { parseMongoUrl, MongoDbConnector } from "./mongodb.js";
import type { EngineConfig } from "../config.js";

// Mock the mongodb driver (loaded lazily via import() on first use) so client
// option plumbing can be asserted without a live server.
const { mongoClientCtorMock } = vi.hoisted(() => ({ mongoClientCtorMock: vi.fn() }));
vi.mock("mongodb", () => ({
  MongoClient: mongoClientCtorMock,
  default: { MongoClient: mongoClientCtorMock },
}));

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

describe("MongoDbConnector — timeouts (Task 1.3)", () => {
  function makeClientMock() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockReturnValue({ collection: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("plumbs connect/selection timeouts into the MongoClient and rebuilds on override", async () => {
    vi.clearAllMocks();
    const clientA = makeClientMock();
    const clientB = makeClientMock();
    mongoClientCtorMock.mockReturnValueOnce(clientA).mockReturnValueOnce(clientB);
    const connector = new MongoDbConnector();
    const cfg: EngineConfig = { type: "mongodb", url: "mongodb://u:p@localhost:27017/db" };

    await (connector as any).getClient("t1", cfg);
    expect(mongoClientCtorMock.mock.calls[0][1]).toMatchObject({
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    await (connector as any).getClient("t1", cfg);
    expect(mongoClientCtorMock).toHaveBeenCalledTimes(1);

    // A later override on the same engineId must not be silently ignored by
    // the cached client: the stale client is torn down and a fresh one built.
    await (connector as any).getClient("t1", { ...cfg, connectTimeoutMs: 20000 });
    expect(mongoClientCtorMock).toHaveBeenCalledTimes(2);
    expect(mongoClientCtorMock.mock.calls[1][1]).toMatchObject({
      serverSelectionTimeoutMS: 20000,
      connectTimeoutMS: 20000,
    });
    expect(clientA.close).toHaveBeenCalled();
  });

  it("rejects with a timeout error when a find hangs past queryTimeoutMs", async () => {
    const connector = new MongoDbConnector();
    const toArray = vi.fn().mockImplementation(() => new Promise(() => {}));
    const limit = vi.fn().mockReturnValue({ toArray });
    const find = vi.fn().mockReturnValue({ limit });
    const collection = vi.fn().mockReturnValue({ find });
    const client = { db: vi.fn().mockReturnValue({ collection }) };
    // @ts-expect-error - we're mocking the private client cache
    connector.clients.set("slow-mongo", client);
    const config: EngineConfig = { type: "mongodb", url: "mongodb://u:p@localhost:27017/db", queryTimeoutMs: 25 };

    await expect(connector.query("slow-mongo", config, JSON.stringify({ find: "c" })))
      .rejects.toThrow(/exceeded its 25ms/);
    // The per-operation bound must reach the driver as maxTimeMS.
    expect(find).toHaveBeenCalledWith({}, { maxTimeMS: 25 });
  });
});