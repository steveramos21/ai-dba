import { describe, it, expect, vi } from "vitest";
import { parseOracleUrl, OracleConnector } from "./oracle.js";
import type { EngineConfig } from "../config.js";

// Mock the oracledb driver (loaded lazily via import() on first use) so pool
// option plumbing and timeout behavior can be asserted without a live server.
const { oracleCreatePoolMock } = vi.hoisted(() => ({ oracleCreatePoolMock: vi.fn() }));
vi.mock("oracledb", () => ({
  createPool: oracleCreatePoolMock,
  default: { createPool: oracleCreatePoolMock, Pool: {}, Connection: {} },
}));

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

describe("OracleConnector — timeouts (Task 1.3)", () => {
  it("passes connectTimeout in seconds and rebuilds the pool on override", async () => {
    vi.clearAllMocks();
    const poolA = { close: vi.fn().mockResolvedValue(undefined), getConnection: vi.fn() };
    const poolB = { close: vi.fn().mockResolvedValue(undefined), getConnection: vi.fn() };
    oracleCreatePoolMock.mockResolvedValueOnce(poolA).mockResolvedValueOnce(poolB);
    const connector = new OracleConnector();
    const cfg: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE" };

    // 10000 ms default must reach node-oracledb as 10 seconds — the thin
    // driver multiplies connectTimeout by 1000 internally.
    expect(await (connector as any).getPool("t1", cfg)).toBe(poolA);
    expect(oracleCreatePoolMock.mock.calls[0][0]).toMatchObject({ poolMin: 1, poolMax: 5, connectTimeout: 10 });

    expect(await (connector as any).getPool("t1", cfg)).toBe(poolA);
    expect(oracleCreatePoolMock).toHaveBeenCalledTimes(1);

    const overridden = { ...cfg, connectTimeoutMs: 15000 };
    expect(await (connector as any).getPool("t1", overridden)).toBe(poolB);
    expect(oracleCreatePoolMock).toHaveBeenCalledTimes(2);
    expect(oracleCreatePoolMock.mock.calls[1][0].connectTimeout).toBe(15);
    expect(poolA.close).toHaveBeenCalled();
  });

  it("drops the session after a query exceeds queryTimeoutMs", async () => {
    const connector = new OracleConnector();
    const fakeConn = {
      execute: vi.fn().mockImplementation(() => new Promise(() => {})),
      close: vi.fn(),
      callTimeout: 0,
    };
    const fakePool = { getConnection: vi.fn().mockResolvedValue(fakeConn) };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("slow-oracle", fakePool);
    const config: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE", queryTimeoutMs: 25 };

    await expect(connector.query("slow-oracle", config, "SELECT id FROM t"))
      .rejects.toThrow(/exceeded its 25ms/);
    expect(fakeConn.callTimeout).toBe(25);
    expect(fakeConn.close).toHaveBeenCalledWith({ drop: true });
  });

  it("releases the caller at the timeout even while close() is still pending (caller-bound contract)", async () => {
    // The v1 AFTER run caught this: oracledb's close() waits for the
    // in-flight call to settle, so an awaited drop held the caller to server
    // completion (live: SLEEP(30) surfaced at 30.3s). The teardown is
    // detached on the timeout path; this pins that the caller must be
    // released near the timeout window even when close() never settles.
    const connector = new OracleConnector();
    const never = new Promise<never>(() => {});
    const fakeConn = {
      execute: vi.fn().mockImplementation(() => never),
      close: vi.fn().mockImplementation(() => never),
      callTimeout: 0,
    };
    const fakePool = { getConnection: vi.fn().mockResolvedValue(fakeConn) };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("slow-oracle-pending-close", fakePool);
    const config: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE", queryTimeoutMs: 25 };

    const t0 = Date.now();
    await expect(connector.query("slow-oracle-pending-close", config, "SELECT id FROM t"))
      .rejects.toThrow(/exceeded its 25ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(fakeConn.close).toHaveBeenCalledWith({ drop: true });
  });

  it("treats a thin-driver NJS-123 callTimeout rejection as the timeout path (drop, not plain close)", async () => {
    const connector = new OracleConnector();
    const njs = new Error("NJS-123: call timeout of 25 ms exceeded");
    const fakeConn = {
      execute: vi.fn().mockRejectedValue(njs),
      close: vi.fn(),
      callTimeout: 0,
    };
    const fakePool = { getConnection: vi.fn().mockResolvedValue(fakeConn) };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("njs-oracle", fakePool);
    const config: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE", queryTimeoutMs: 25 };

    await expect(connector.query("njs-oracle", config, "SELECT id FROM t"))
      .rejects.toThrow(/NJS-123/);
    // The session must be dropped (never handed back to the pool), exactly as
    // for our own race expiry — and never closed via the plain path.
    expect(fakeConn.close).toHaveBeenCalledWith({ drop: true });
    expect(fakeConn.close).toHaveBeenCalledTimes(1);
  });
});

describe("OracleConnector — degraded-on-empty (Task 1.4 / Q8 guard)", () => {
  function setup(engineId: string, err: unknown) {
    const connector = new OracleConnector();
    const fakeConn = { execute: vi.fn().mockRejectedValue(err), close: vi.fn() };
    const fakePool = { getConnection: vi.fn().mockResolvedValue(fakeConn) };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set(engineId, fakePool);
    const config: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE" };
    return { connector, config };
  }

  it("returns empty queries + degraded reason when v$ access is denied (ORA-00942)", async () => {
    const denied = new Error("ORA-00942: table or view does not exist");
    const { connector, config } = setup("deg-oracle", denied);

    const result = await connector.listSlowQueries("deg-oracle", config);

    expect(Array.isArray(result)).toBe(false);
    expect(result.queries).toEqual([]);
    expect(result.degraded?.reason).toContain("ORA-00942");
  });

  it("rethrows ORA-00904 wrong-column errors (Q8 guard — the ORA-00904 case named in the plan)", async () => {
    const wrongColumn = new Error('ORA-00904: "ELAPSED_TIME_XX": invalid identifier');
    const { connector, config } = setup("deg-oracle", wrongColumn);

    await expect(connector.listSlowQueries("deg-oracle", config)).rejects.toThrow(/ORA-00904/);
  });
});

describe("OracleConnector — explain degraded (Task 1.4)", () => {
  function setupExplain(engineId: string, executeImpl: (sql: string) => Promise<unknown>) {
    const connector = new OracleConnector();
    const fakeConn = { execute: vi.fn().mockImplementation(executeImpl), close: vi.fn() };
    const fakePool = { getConnection: vi.fn().mockResolvedValue(fakeConn) };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set(engineId, fakePool);
    const config: EngineConfig = { type: "oracle", url: "oracle://u:p@localhost:1521/XE" };
    return { connector, config };
  }

  it("surfaces a degraded reason when DBMS_XPLAN is unavailable and the plan comes from plan_table", async () => {
    const { connector, config } = setupExplain("explain-oracle", (sql: string) => {
      if (sql.includes("DBMS_XPLAN")) {
        return Promise.reject(new Error("ORA-00942: table or view does not exist"));
      }
      if (sql.includes("FROM plan_table") && sql.includes("SELECT")) {
        return Promise.resolve({ rows: [["| Id | Operation |"], ["| 0 | SELECT STATEMENT |"]] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await connector.explainQuery("explain-oracle", config, "SELECT 1 FROM DUAL");

    expect(result.plan).toContain("SELECT STATEMENT");
    expect(result.degraded).toContain("DBMS_XPLAN");
    expect(result.degraded).toContain("ORA-00942");
  });

  it("still throws when every plan source fails (no silent fallback-to-empty)", async () => {
    const { connector, config } = setupExplain("explain-oracle", (sql: string) => {
      if (sql.includes("EXPLAIN PLAN")) {
        return Promise.reject(new Error('ORA-00904: "NOPE": invalid identifier'));
      }
      return Promise.reject(new Error("ORA-00942: table or view does not exist"));
    });

    await expect(connector.explainQuery("explain-oracle", config, "SELECT bad FROM t"))
      .rejects.toThrow(/ORA-00904/);
  });
});