import { describe, it, expect, vi } from "vitest";
import { parseSqlServerUrl, SqlServerConnector } from "./sqlserver.js";
import type { EngineConfig } from "../config.js";

// Mock the tedious driver (loaded lazily via import() on first use) so
// connection option plumbing can be asserted without a live server.
const { connectionCtorMock } = vi.hoisted(() => ({ connectionCtorMock: vi.fn() }));
vi.mock("tedious", () => ({
  Connection: connectionCtorMock,
  default: { Connection: connectionCtorMock },
}));

// Unit tests cover the pure function only.
// Connector methods (listDatabases, listTables, etc.) are validated via
// integration tests against a live SQL Server Docker container.

describe("parseSqlServerUrl", () => {
  it("extracts connection components", () => {
    const r = parseSqlServerUrl("sqlserver://sa:pass@10.0.0.1:1433/mydb");
    expect(r.server).toBe("10.0.0.1");
    expect(r.port).toBe(1433);
    expect(r.userName).toBe("sa");
    expect(r.password).toBe("pass");
    expect(r.database).toBe("mydb");
  });

  it("uses defaults for missing port", () => {
    const r = parseSqlServerUrl("sqlserver://sa:pass@host/db");
    expect(r.port).toBe(1433);
    expect(r.userName).toBe("sa");
  });

  it("handles URL-encoded passwords", () => {
    const r = parseSqlServerUrl("sqlserver://sa:p%40ss%21w0rd@host:1433/db");
    expect(r.password).toBe("p@ss!w0rd");
  });

  it("throws on invalid URL", () => {
    expect(() => parseSqlServerUrl("not-a-url")).toThrow("Invalid SQL Server URL");
  });
});

describe("SqlServerConnector — row cap (Task 1.2)", () => {
  function setupCap(rows: Record<string, unknown>[]) {
    const connector = new SqlServerConnector();
    const conn = { execSql: vi.fn().mockResolvedValue({ columns: ["id"], rows }), close: vi.fn() };
    // @ts-expect-error - we're mocking the private connection cache
    connector.connections.set("cap-engine", conn);
    const config: EngineConfig = { type: "sqlserver", url: "sqlserver://sa:x@localhost:1433/db", rowLimit: 2 };
    return { connector, conn, config };
  }

  it("rewrites a bare SELECT with TOP (n+1) and flags truncation when the extra row arrives", async () => {
    const { connector, conn, config } = setupCap([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await connector.query("cap-engine", config, "SELECT id FROM t");

    expect(conn.execSql.mock.calls[0][0]).toBe("SELECT TOP (3) id FROM t");
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.rowCap).toBe(2);
  });

  it("does not flag truncation when rows are at or under the cap", async () => {
    const { connector, config } = setupCap([{ id: 1 }, { id: 2 }]);

    const result = await connector.query("cap-engine", config, "SELECT id FROM t");

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
    expect(result.rowCap).toBeUndefined();
  });

  it("runs the statement as written and slices client-side when the rewrite is unsafe (WITH)", async () => {
    const { connector, conn, config } = setupCap([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await connector.query("cap-engine", config, "WITH x AS (SELECT 1 AS id) SELECT id FROM x");

    const sql = conn.execSql.mock.calls[0][0] as string;
    expect(sql).toContain("WITH x AS");
    expect(sql).not.toContain("TOP");
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe("SqlServerConnector — timeouts (Task 1.3)", () => {
  function mockTediousConn() {
    const listeners: Record<string, Array<(err?: unknown) => void>> = {};
    return {
      on(ev: string, cb: (err?: unknown) => void) {
        (listeners[ev] ??= []).push(cb);
        return this;
      },
      connect() {
        for (const cb of listeners["connect"] ?? []) cb(undefined);
      },
      close: vi.fn(),
    };
  }

  it("plumbs connectTimeout/requestTimeout into the tedious config and rebuilds the connection on override", async () => {
    vi.clearAllMocks();
    const connA = mockTediousConn();
    const connB = mockTediousConn();
    connectionCtorMock.mockReturnValueOnce(connA).mockReturnValueOnce(connB);
    const connector = new SqlServerConnector();
    const cfg: EngineConfig = { type: "sqlserver", url: "sqlserver://sa:x@localhost:1433/db" };

    // requestTimeout must be explicit: tedious defaults it to 15000 ms, which
    // sits BELOW the 30000 code default and would fail allowed queries early.
    await (connector as any).getConnection("t1", cfg);
    expect(connectionCtorMock.mock.calls[0][0].options).toMatchObject({
      connectTimeout: 10000,
      requestTimeout: 30000,
    });

    await (connector as any).getConnection("t1", cfg);
    expect(connectionCtorMock).toHaveBeenCalledTimes(1);

    // A later override on the same engineId must not be silently ignored by
    // the cached connection: the stale one is closed and a fresh one built.
    await (connector as any).getConnection("t1", { ...cfg, queryTimeoutMs: 5000 });
    expect(connectionCtorMock).toHaveBeenCalledTimes(2);
    expect(connectionCtorMock.mock.calls[1][0].options.requestTimeout).toBe(5000);
    expect(connA.close).toHaveBeenCalled();

    // The new fingerprint sticks — no further rebuilds.
    await (connector as any).getConnection("t1", { ...cfg, queryTimeoutMs: 5000 });
    expect(connectionCtorMock).toHaveBeenCalledTimes(2);
  });
});

describe("SqlServerConnector — degraded-on-empty (Task 1.4 / Q8 guard)", () => {
  function setup(engineId: string, err: unknown) {
    const connector = new SqlServerConnector();
    const conn = { execSql: vi.fn().mockRejectedValue(err), close: vi.fn() };
    // @ts-expect-error - we're mocking the private connection cache
    connector.connections.set(engineId, conn);
    const config: EngineConfig = { type: "sqlserver", url: "sqlserver://sa:x@localhost:1433/db" };
    return { connector, config };
  }

  it("returns empty queries + degraded reason when VIEW SERVER STATE is denied", async () => {
    const denied = new Error(
      "The SELECT permission was denied on the object 'dm_exec_query_stats', database 'mssqlsystemresource', schema 'sys'."
    );
    const { connector, config } = setup("deg-engine", denied);

    const result = await connector.listSlowQueries("deg-engine", config);

    expect(Array.isArray(result)).toBe(false);
    expect(result.queries).toEqual([]);
    expect(result.degraded?.reason).toMatch(/VIEW SERVER STATE/);
  });

  it("rethrows invalid-column errors instead of the old blanket catch (Q8 guard)", async () => {
    // The old code was a bare `catch {}` that swallowed EVERYTHING,
    // including this ORA-00904-class error.
    const bad = new Error("Invalid column name 'qs'.");
    const { connector, config } = setup("deg-engine", bad);

    await expect(connector.listSlowQueries("deg-engine", config)).rejects.toThrow(/Invalid column name/);
  });
});