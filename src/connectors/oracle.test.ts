import { describe, it, expect, vi } from "vitest";
import { parseOracleUrl, OracleConnector } from "./oracle.js";
import type { EngineConfig } from "../config.js";

describe("parseOracleUrl", () => {
  it("extracts connection components", () => {
    const r = parseOracleUrl("oracle://scott:tiger@10.0.0.1:1521/ORCL");
    expect(r.user).toBe("scott");
    expect(r.password).toBe("tiger");
    expect(r.connectString).toBe("10.0.0.1:1521/ORCL");
  });

  it("uses default port 1521 when not specified", () => {
    const r = parseOracleUrl("oracle://scott:tiger@host/XE");
    expect(r.connectString).toBe("host:1521/XE");
    expect(r.user).toBe("scott");
  });

  it("handles URL-encoded passwords", () => {
    const r = parseOracleUrl("oracle://scott:p%40ss%21@host:1521/ORCL");
    expect(r.password).toBe("p@ss!");
  });

  it("throws on invalid URL", () => {
    expect(() => parseOracleUrl("not-a-url")).toThrow("Invalid Oracle URL");
  });
});

describe("OracleConnector — row cap (Task 1.2)", () => {
  function setupCap(rows: unknown[][]) {
    const connector = new OracleConnector();
    const fakeConn = {
      execute: vi.fn().mockResolvedValue({ metaData: [{ name: "id" }], rows }),
      close: vi.fn(),
    };
    const fakePool = { getConnection: vi.fn().mockResolvedValue(fakeConn) };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("cap-engine", fakePool);
    const config: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE", rowLimit: 2 };
    return { connector, fakeConn, config };
  }

  it("appends FETCH FIRST n+1 with an explicit driver maxRows and flags truncation", async () => {
    const { connector, fakeConn, config } = setupCap([[1], [2], [3]]);

    const result = await connector.query("cap-engine", config, "SELECT id FROM t");

    const sql = fakeConn.execute.mock.calls[0][0] as string;
    expect(sql).toContain("SELECT id FROM t");
    expect(sql).toContain("\nFETCH FIRST 3 ROWS ONLY");
    // maxRows must be explicit — the driver default would cap below rowLimit.
    expect(fakeConn.execute.mock.calls[0][2]).toMatchObject({ resultSet: false, maxRows: 3 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.rowCap).toBe(2);
  });

  it("does not flag truncation when rows are at or under the cap", async () => {
    const { connector, config } = setupCap([[1], [2]]);

    const result = await connector.query("cap-engine", config, "SELECT id FROM t");

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
    expect(result.rowCap).toBeUndefined();
  });

  it("runs the statement as written and slices client-side when the rewrite is unsafe (ROWNUM)", async () => {
    const { connector, fakeConn, config } = setupCap([[1], [2], [3]]);

    const result = await connector.query("cap-engine", config, "SELECT id FROM t WHERE ROWNUM <= 10");

    const sql = fakeConn.execute.mock.calls[0][0] as string;
    expect(sql).toBe("SELECT id FROM t WHERE ROWNUM <= 10");
    expect(sql).not.toContain("FETCH FIRST");
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});