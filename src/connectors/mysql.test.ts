import { describe, it, expect, vi, beforeEach } from "vitest";
import { MySQLConnector } from "./mysql.js";
import type { EngineConfig } from "../config.js";

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