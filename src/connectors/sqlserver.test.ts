import { describe, it, expect, vi } from "vitest";
import { parseSqlServerUrl, SqlServerConnector } from "./sqlserver.js";
import type { EngineConfig } from "../config.js";

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