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

describe("MongoDbConnector — degraded-on-empty (Task 1.4 / Q8 guard)", () => {
  function setup(engineId: string, err: unknown) {
    const command = vi.fn().mockRejectedValue(err);
    const client = { db: vi.fn().mockReturnValue({ admin: () => ({ command }) }) };
    const connector = new MongoDbConnector();
    // @ts-expect-error - we're mocking the private client cache
    connector.clients.set(engineId, client);
    const config: EngineConfig = { type: "mongodb", url: "mongodb://u:***@localhost:27017/db" };
    return { connector, config };
  }

  it("returns empty queries + degraded reason when currentOp is unauthorized (code 13)", async () => {
    const denied = Object.assign(new Error("not authorized on admin to execute command { currentOp: 1 }"), { code: 13 });
    const { connector, config } = setup("deg-mongo", denied);

    const result = await connector.listSlowQueries("deg-mongo", config);

    expect(Array.isArray(result)).toBe(false);
    expect(result.queries).toEqual([]);
    expect(result.degraded?.reason).toMatch(/clusterMonitor/);
  });

  it("rethrows a generic currentOp failure instead of collapsing it into empty+degraded (Q8 guard)", async () => {
    const transport = new Error("connection reset by peer");
    const { connector, config } = setup("deg-mongo", transport);

    await expect(connector.listSlowQueries("deg-mongo", config)).rejects.toThrow(/connection reset by peer/);
  });
});

describe("MongoDbConnector — cap on aggregate/distinct/count branches (review m2)", () => {
  function setupCmd(coll: Record<string, unknown>) {
    const connector = new MongoDbConnector();
    const collection = vi.fn().mockReturnValue(coll);
    const client = { db: vi.fn().mockReturnValue({ collection }) };
    // @ts-expect-error - we're mocking the private client cache
    connector.clients.set("cmd-engine", client);
    const config: EngineConfig = { type: "mongodb", url: "mongodb://u:***@localhost:27017/db", rowLimit: 2 };
    return { connector, config };
  }

  it("aggregate: appends $limit(cap+1) and flags truncation", async () => {
    const toArray = vi.fn().mockResolvedValue([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
    const aggregate = vi.fn().mockReturnValue({ toArray });
    const { connector, config } = setupCmd({ aggregate });
    const pipeline = [{ $match: {} }];

    const res = await connector.query("cmd-engine", config, JSON.stringify({ aggregate: "c", pipeline }));

    expect(aggregate).toHaveBeenCalledWith([{ $match: {} }, { $limit: 3 }], { maxTimeMS: 30000 });
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(true);
    expect(res.rowCap).toBe(2);
  });

  it("aggregate: never appends $limit after a terminal $out/$merge stage (runs as written, slices client-side)", async () => {
    const toArray = vi.fn().mockResolvedValue([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
    const aggregate = vi.fn().mockReturnValue({ toArray });
    const { connector, config } = setupCmd({ aggregate });
    const pipeline = [{ $match: {} }, { $out: "x" }];

    const res = await connector.query("cmd-engine", config, JSON.stringify({ aggregate: "c", pipeline }));

    expect(aggregate).toHaveBeenCalledWith(pipeline, { maxTimeMS: 30000 });
    // Non-mutation pin: a push-based regression would make the call argument
    // and `pipeline` the same mutated reference - deep equality would then
    // pass vacuously (review catch on the original draft).
    expect(pipeline).toHaveLength(2);
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it("distinct: caps values client-side with the honest flag", async () => {
    const distinct = vi.fn().mockResolvedValue(["a", "b", "c"]);
    const { connector, config } = setupCmd({ distinct });

    const res = await connector.query("cmd-engine", config, JSON.stringify({ distinct: "c", field: "v" }));

    expect(distinct).toHaveBeenCalledWith("v", {}, { maxTimeMS: 30000 });
    expect(res.columns).toEqual(["v"]);
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it("count: single-doc result path stays flag-clean", async () => {
    const countDocuments = vi.fn().mockResolvedValue(7);
    const config: EngineConfig = { type: "mongodb", url: "mongodb://u:***@localhost:27017/db", rowLimit: 2 };
    const connector = new MongoDbConnector();
    const coll2 = { countDocuments };
    const client2 = { db: vi.fn().mockReturnValue({ collection: vi.fn().mockReturnValue(coll2) }) };
    // @ts-expect-error - we're mocking the private client cache
    connector.clients.set("cmd-engine", client2);

    const res = await connector.query("cmd-engine", config, JSON.stringify({ count: "c", filter: {} }));

    expect(countDocuments).toHaveBeenCalledWith({}, { maxTimeMS: 30000 });
    expect(res.rows).toEqual([{ count: 7 }]);
    expect(res.truncated).toBeUndefined();
    expect(res.rowCap).toBeUndefined();
  });
});
