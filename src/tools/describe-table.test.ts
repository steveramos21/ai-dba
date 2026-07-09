import { describe, it, expect, vi } from "vitest";
import { registerDescribeTableTool } from "./describe-table.js";
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
    "mysql-test": { type: "mysql", url: "mysql://root:t@localhost/db" },
    "pg-test": { type: "postgres", url: "postgresql://postgres@localhost/db" },
  },
};

describe("describe-table tool", () => {
  it("returns columns as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = { describeTable: vi.fn().mockResolvedValue([
      { name: "id", type: "int", nullable: false, isPrimary: true, isAutoIncrement: true },
    ]) };
    registerDescribeTableTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["describe-table"]({ engineId: "mysql-test", table: "users" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.columns[0].name).toBe("id");
    expect(body.columns[0].isPrimary).toBe(true);
    expect(body.count).toBe(1);
  });

  it("passes database parameter to connector", async () => {
    const { server, handlers } = mockServer();
    const conn = { describeTable: vi.fn().mockResolvedValue([]) };
    registerDescribeTableTool(server, config, { mysql: conn as any, postgres: conn as any });

    await handlers["describe-table"]({ engineId: "mysql-test", table: "users", database: "other_db" });
    expect(conn.describeTable).toHaveBeenCalledWith("mysql-test", expect.anything(), "users", "other_db");
  });

  it("returns not-found message for empty columns", async () => {
    const { server, handlers } = mockServer();
    const conn = { describeTable: vi.fn().mockResolvedValue([]) };
    registerDescribeTableTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["describe-table"]({ engineId: "mysql-test", table: "nope" });
    const body = JSON.parse(res.content[0].text);
    expect(body.count).toBe(0);
    expect(body.message).toContain("not found");
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerDescribeTableTool(server, config, { mysql: {} as any });

    const res = await handlers["describe-table"]({ engineId: "ghost", table: "users" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });
});