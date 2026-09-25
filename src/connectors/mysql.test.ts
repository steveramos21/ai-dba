import { describe, it, expect, vi, beforeEach } from "vitest";
import { MySQLConnector } from "./mysql.js";
import type { EngineConfig } from "../config.js";

const { createPoolMock } = vi.hoisted(() => ({ createPoolMock: vi.fn() }));

// Mock the mysql2 driver: the connector loads it lazily via import() on first
// use. Mocking lets us assert cold-start pool de-duplication.
vi.mock("mysql2/promise", () => ({
  createPool: createPoolMock,
  default: { createPool: createPoolMock },
}));


describe("MySQLConnector", () => {
  let connector: MySQLConnector;
  const mockConfig: EngineConfig = {
    type: "mysql",
    host: "localhost",
    port: 3306,
    user: "root",
    password: "testpassword",
    database: "testdb",
  };

  beforeEach(() => {
    connector = new MySQLConnector();
    vi.clearAllMocks();
  });

  it("should throw error for non-read-only SQL in query method", async () => {
    const pool = {
      getConnection: vi.fn().mockResolvedValue({
        query: vi.fn(),
        release: vi.fn(),
      }),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    await expect(
      connector.query("test-engine", mockConfig, "DROP TABLE test")
    ).rejects.toThrow("Only read-only queries");

    // Ensure that we never attempted to get a connection from the pool
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it("should allow read-only SQL in query method", async () => {
    const mockConnection = {
      query: vi.fn().mockResolvedValue([
        [{ id: 1, name: "test" }], // rows
        [{ name: "id" }, { name: "name" }], // fields
      ]),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn().mockResolvedValue(mockConnection),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    // Test SELECT
    await expect(
      connector.query("test-engine", mockConfig, "SELECT * FROM test")
    ).resolves.toEqual({
      columns: ["id", "name"],
      rows: [{ id: 1, name: "test" }],
    });

    // Ensure the mock connection's query was called
    expect(mockConnection.query).toHaveBeenCalled();
  });

  it("should map blocking chain rows with correct field assignments", async () => {
    const mockRows = [
      {
        blocking_pid: 101,
        blocked_pid: 202,
        wait_duration_ms: 5500,
        wait_event: "LOCK WAIT",
        blocking_query: "UPDATE users SET name='x' WHERE id=1",
        blocked_query: "SELECT * FROM users WHERE id=1",
        database_name: "appdb",
        wait_type: null,
        status: "updating",
        host_name: "10.0.0.5:54321",
        program_name: null,
        login_time: "2026-06-20 10:30:00",
      },
    ];
    const mockConnection = {
      query: vi.fn().mockResolvedValue([mockRows, []]),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn().mockResolvedValue(mockConnection),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    const chains = await connector.getBlockingChains("test-engine", mockConfig);

    expect(chains).toHaveLength(1);
    const c = chains[0];
    // Required fields
    expect(c.engine_id).toBe("test-engine");
    expect(c.blocking_pid).toBe(101);
    expect(c.blocked_pid).toBe(202);
    // Nullable fields — verify correct mapping (not swapped)
    expect(c.wait_duration_ms).toBe(5500);
    expect(c.wait_event).toBe("LOCK WAIT");
    expect(c.blocking_query).toBe("UPDATE users SET name='x' WHERE id=1");
    expect(c.blocked_query).toBe("SELECT * FROM users WHERE id=1");
    expect(c.database_name).toBe("appdb");
    expect(c.wait_type).toBeNull();
    expect(c.status).toBe("updating");
    expect(c.host_name).toBe("10.0.0.5:54321");
    expect(c.program_name).toBeNull();
    expect(c.login_time).toBe("2026-06-20 10:30:00");

    // Verify the SQL uses the MySQL 8.0+ data_lock_waits query (not the old INNODB_LOCK_WAITS)
    const sql = mockConnection.query.mock.calls[0][0] as string;
    expect(sql).toContain("performance_schema.data_lock_waits");
    expect(sql).toContain("BLOCKING_ENGINE_TRANSACTION_ID");
    expect(sql).toContain("REQUESTING_ENGINE_TRANSACTION_ID");
    expect(sql).toContain("PROCESSLIST_ID");
    expect(sql).not.toContain("INNODB_LOCK_WAITS");
  });
});

describe("MySQLConnector — cold-start concurrency", () => {
  const mockConfig: EngineConfig = {
    type: "mysql",
    host: "localhost",
    port: 3306,
    user: "root",
    password: "testpassword",
    database: "testdb",
  };

  it("de-duplicates concurrent pool creation on a cold engine", async () => {
    const sentinel = { end: vi.fn() };
    createPoolMock.mockReturnValue(sentinel);

    const connector = new MySQLConnector();
    const [a, b] = await Promise.all([
      connector.getPool("dedupe-engine", mockConfig),
      connector.getPool("dedupe-engine", mockConfig),
    ]);

    expect(a).toBe(sentinel);
    expect(b).toBe(sentinel);
    expect(createPoolMock).toHaveBeenCalledTimes(1);

    // Warm path reuses the pooled instance without re-creating
    const c = await connector.getPool("dedupe-engine", mockConfig);
    expect(c).toBe(sentinel);
    expect(createPoolMock).toHaveBeenCalledTimes(1);
  });
});

describe("MySQLConnector — row cap (Task 1.2)", () => {
  function setupCap(rows: Record<string, unknown>[]) {
    const connector = new MySQLConnector();
    const mockConnection = {
      query: vi.fn().mockResolvedValue([rows, [{ name: "id" }]]),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn().mockResolvedValue(mockConnection),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("cap-engine", pool);
    const config: EngineConfig = { type: "mysql", url: "mysql://root@localhost/db", rowLimit: 2 };
    return { connector, mockConnection, config };
  }

  it("rewrites a bare SELECT with LIMIT n+1 and flags truncation when the extra row arrives", async () => {
    const { connector, mockConnection, config } = setupCap([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await connector.query("cap-engine", config, "SELECT * FROM t");

    // Task 1.3: SELECT/WITH gets a bounded SET SESSION prelude first, then the
    // capped query itself (object form carries the per-query timeout).
    const calls = mockConnection.query.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].sql).toBe("SET SESSION max_execution_time = 30000");
    expect(calls[1][0].sql).toContain("SELECT * FROM t");
    expect(calls[1][0].sql).toContain("\nLIMIT 3");
    expect(calls[1][0].timeout).toBe(30000);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.rowCap).toBe(2);
  });

  it("does not flag truncation when rows are at or under the cap", async () => {
    const { connector, config } = setupCap([{ id: 1 }, { id: 2 }]);

    const result = await connector.query("cap-engine", config, "SELECT * FROM t");

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
    expect(result.rowCap).toBeUndefined();
  });

  it("runs the statement as written and slices client-side when no rewrite is safe (SHOW)", async () => {
    const { connector, mockConnection, config } = setupCap([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await connector.query("cap-engine", config, "SHOW TABLES");

    const calls = mockConnection.query.mock.calls;
    // Non-SELECT: no SET SESSION prelude — exactly one call, object form.
    expect(calls).toHaveLength(1);
    expect(calls[0][0].sql).toBe("SHOW TABLES");
    expect(calls[0][0].sql).not.toContain("LIMIT");
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe("MySQLConnector — timeouts (Task 1.3)", () => {
  const baseConfig: EngineConfig = { type: "mysql", url: "mysql://root@localhost/db" };

  it("rebuilds the pool when the timeout config changes for the same engineId", async () => {
    vi.clearAllMocks();
    const poolA = { end: vi.fn() };
    const poolB = { end: vi.fn() };
    createPoolMock.mockReturnValueOnce(poolA).mockReturnValueOnce(poolB);
    const connector = new MySQLConnector();

    expect(await connector.getPool("override-engine", baseConfig)).toBe(poolA);
    // Plumbing: the URL form must go through an options object so
    // connectTimeout actually applies (a bare URL string would drop it).
    expect(createPoolMock.mock.calls[0][0]).toMatchObject({
      uri: "mysql://root@localhost/db",
      connectTimeout: 10000,
    });
    expect(await connector.getPool("override-engine", baseConfig)).toBe(poolA);
    expect(createPoolMock).toHaveBeenCalledTimes(1);

    // A later override on the same engineId must not be silently ignored by
    // the cached pool: the stale pool is torn down and a fresh one built.
    const overridden = { ...baseConfig, queryTimeoutMs: 5000 };
    expect(await connector.getPool("override-engine", overridden)).toBe(poolB);
    expect(createPoolMock).toHaveBeenCalledTimes(2);
    expect(poolA.end).toHaveBeenCalled();

    // The new fingerprint sticks — no further rebuilds.
    expect(await connector.getPool("override-engine", overridden)).toBe(poolB);
    expect(createPoolMock).toHaveBeenCalledTimes(2);
  });

  it("destroys the connection when a query exceeds queryTimeoutMs", async () => {
    const connector = new MySQLConnector();
    const mockConnection = {
      query: vi.fn()
        .mockResolvedValueOnce([[], []])                       // SET SESSION prelude
        .mockImplementationOnce(() => new Promise(() => {})),  // main query hangs
      release: vi.fn(),
      destroy: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(mockConnection), end: vi.fn() };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("slow-engine", pool);
    const config: EngineConfig = { type: "mysql", url: "mysql://root@localhost/db", queryTimeoutMs: 25 };

    await expect(connector.query("slow-engine", config, "SELECT * FROM t"))
      .rejects.toThrow(/exceeded its 25ms/);
    expect(mockConnection.destroy).toHaveBeenCalled();
  });
});
