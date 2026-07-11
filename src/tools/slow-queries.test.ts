import { describe, it, expect, vi } from "vitest";
import { registerSlowQueriesTool } from "./slow-queries.js";
import type { AiDbaConfig } from "../config.js";

function mockServer() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<any>> = {};
  return {
    server: { tool: (n: string, _d: string, _s: unknown, fn: any) => { handlers[n] = fn; } } as any,
    handlers,
  };
}

const config: AiDbaConfig = {
  engines: {
    "mysql-test": { type: "mysql", url: "mysql://root:***@localhost/db" },
    "pg-test": { type: "postgres", url: "postgresql://postgres@localhost/db" },
  },
};

describe("slow-queries tool", () => {
  it("returns slow queries as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listSlowQueries: vi.fn().mockResolvedValue([
        { id: "mysql-0", query: "SELECT * FROM orders", totalExecutionTimeMs: 5000, executionCount: 100 },
        { id: "mysql-1", query: "SELECT * FROM users WHERE id = 1", totalExecutionTimeMs: 3000, executionCount: 50 },
      ]),
    };
    registerSlowQueriesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["slow-queries"]({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.slowQueries[0].query).toBe("SELECT * FROM orders");
    expect(body.slowQueries[0].totalExecutionTimeMs).toBe(5000);
    expect(body.count).toBe(2);
  });

  it("passes limit and minDurationMs options to connector", async () => {
    const { server, handlers } = mockServer();
    const conn = { listSlowQueries: vi.fn().mockResolvedValue([]) };
    registerSlowQueriesTool(server, config, { mysql: conn as any, postgres: conn as any });

    await handlers["slow-queries"]({ engineId: "pg-test", limit: 5, minDurationMs: 500 });
    expect(conn.listSlowQueries).toHaveBeenCalledWith("pg-test", expect.anything(), { limit: 5, minDurationMs: 500 });
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerSlowQueriesTool(server, config, { mysql: {} as any });

    const res = await handlers["slow-queries"]({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("propagates connector errors", async () => {
    const { server, handlers } = mockServer();
    const conn = { listSlowQueries: vi.fn().mockRejectedValue(new Error("Connection refused")) };
    registerSlowQueriesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["slow-queries"]({ engineId: "mysql-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Connection refused");
  });
});