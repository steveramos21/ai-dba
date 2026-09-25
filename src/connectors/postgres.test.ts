import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostgreSQLConnector } from "./postgres.js";
import type { EngineConfig } from "../config.js";

const { poolCtorMock } = vi.hoisted(() => ({ poolCtorMock: vi.fn() }));

// Mock the pg driver (loaded lazily via import() on first use).
vi.mock("pg", () => ({
  Pool: poolCtorMock,
  default: { Pool: poolCtorMock },
}));


describe("PostgreSQLConnector", () => {
  let connector: PostgreSQLConnector;
  const mockConfig: EngineConfig = { type: "postgres", url: "postgresql://postgres@localhost:5432/testdb" };

  beforeEach(() => {
    connector = new PostgreSQLConnector();
    vi.clearAllMocks();
  });

  it("should list databases", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ name: "testdb", charset: "UTF8" }] }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    const result = await connector.listDatabases("test-engine", mockConfig);
    expect(result).toEqual([{ name: "testdb", charset: "UTF8" }]);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_database")
    );
  });

  it("should throw error for non-read-only SQL in query method", async () => {
    const pool = {
      connect: vi.fn().mockResolvedValue({
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
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("should allow read-only SQL in query method", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "test" }],
        rowCount: 1,
        fields: [{ name: "id", dataTypeID: 23 }, { name: "name", dataTypeID: 25 }],
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
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

    // Ensure the mock client's query was called
    expect(mockClient.query).toHaveBeenCalled();
  });

  it("should map blocking chain rows with correct field assignments", async () => {
    const mockRows = [
      {
        blocking_pid: 301,
        blocked_pid: 302,
        wait_duration_ms: 3200.5,
        wait_event: "Lock",
        blocking_query: "UPDATE accounts SET balance = 0 WHERE id = 1",
        blocked_query: "SELECT * FROM accounts WHERE id = 1",
        database_name: "appdb",
        wait_type: "Lock",
        status: "active",
        host_name: "192.168.1.50",
        program_name: "psql",
        login_time: "2026-06-20 10:30:00.123456+00",
      },
    ];
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: mockRows, rowCount: 1 }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    const chains = await connector.getBlockingChains("test-engine", mockConfig);

    expect(chains).toHaveLength(1);
    const c = chains[0];
    // Required fields
    expect(c.engine_id).toBe("test-engine");
    expect(c.blocking_pid).toBe(301);
    expect(c.blocked_pid).toBe(302);
    // Nullable fields — verify correct mapping
    expect(c.wait_duration_ms).toBe(3201); // rounded from 3200.5
    expect(c.wait_event).toBe("Lock");
    expect(c.blocking_query).toBe("UPDATE accounts SET balance = 0 WHERE id = 1");
    expect(c.blocked_query).toBe("SELECT * FROM accounts WHERE id = 1");
    expect(c.database_name).toBe("appdb");
    expect(c.wait_type).toBe("Lock");
    expect(c.status).toBe("active");
    expect(c.host_name).toBe("192.168.1.50");
    expect(c.program_name).toBe("psql");
    expect(c.login_time).toBe("2026-06-20 10:30:00.123456+00");

    // Verify the SQL uses pg_blocking_pids and query_start (not state_change)
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain("pg_blocking_pids");
    expect(sql).toContain("unnest");
    expect(sql).toContain("query_start");
    expect(sql).toContain("pg_stat_activity");
    expect(sql).not.toContain("state_change");
  });
});

describe("PostgreSQLConnector — cold-start concurrency", () => {
  const mockConfig: EngineConfig = {
    type: "postgres",
    url: "postgresql://postgres@localhost:5432/testdb",
  };

  it("de-duplicates concurrent pool creation on a cold engine", async () => {
    const sentinel = { end: vi.fn(), connect: vi.fn(), on: vi.fn() };
    poolCtorMock.mockImplementation(() => sentinel);

    const connector = new PostgreSQLConnector();
    const [a, b] = await Promise.all([
      connector.getPool("dedupe-engine", mockConfig),
      connector.getPool("dedupe-engine", mockConfig),
    ]);

    expect(a).toBe(sentinel);
    expect(b).toBe(sentinel);
    expect(poolCtorMock).toHaveBeenCalledTimes(1);
  });
});

describe("PostgreSQLConnector — row cap (Task 1.2)", () => {
  function setupCap(rows: Record<string, unknown>[]) {
    const connector = new PostgreSQLConnector();
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length, fields: [{ name: "id" }] }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("cap-engine", pool);
    const config: EngineConfig = { type: "postgres", url: "postgresql://postgres@localhost/db", rowLimit: 2 };
    return { connector, mockClient, config };
  }

  it("rewrites a bare SELECT with LIMIT n+1 and flags truncation when the extra row arrives", async () => {
    const { connector, mockClient, config } = setupCap([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await connector.query("cap-engine", config, "SELECT * FROM t");

    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain("SELECT * FROM t");
    expect(sql).toContain("\nLIMIT 3");
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

  it("runs the statement as written and slices client-side when the rewrite is unsafe (existing LIMIT)", async () => {
    const { connector, mockClient, config } = setupCap([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await connector.query("cap-engine", config, "SELECT * FROM t LIMIT 50");

    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toBe("SELECT * FROM t LIMIT 50");
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
