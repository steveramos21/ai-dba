import { describe, it, expect, vi } from "vitest";
import { registerExplainTool } from "./explain.js";
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

describe("explain tool", () => {
  it("returns explain result as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      explainQuery: vi.fn().mockResolvedValue({
        plan: '{"query_block": {"select_id": 1}}',
        format: "json",
        analyzed: false,
      }),
    };
    registerExplainTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.explain({ engineId: "mysql-test", query: "SELECT * FROM users" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.plan).toContain("query_block");
    expect(body.format).toBe("json");
    expect(body.analyzed).toBe(false);
  });

  it("passes analyze flag to connector", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      explainQuery: vi.fn().mockResolvedValue({ plan: "{}", format: "json", analyzed: true }),
    };
    registerExplainTool(server, config, { mysql: conn as any, postgres: conn as any });

    await handlers.explain({ engineId: "pg-test", query: "SELECT * FROM users", analyze: true });
    expect(conn.explainQuery).toHaveBeenCalledWith("pg-test", expect.anything(), "SELECT * FROM users", { analyze: true });
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerExplainTool(server, config, { mysql: {} as any });

    const res = await handlers.explain({ engineId: "nope", query: "SELECT 1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("propagates connector errors", async () => {
    const { server, handlers } = mockServer();
    const conn = { explainQuery: vi.fn().mockRejectedValue(new Error("Syntax error")) };
    registerExplainTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.explain({ engineId: "mysql-test", query: "SELECT * FROM nonexistent_table" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Syntax error");
  });
});