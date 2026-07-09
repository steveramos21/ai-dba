import { describe, it, expect, vi } from "vitest";
import { registerTablesTool } from "./tables.js";
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

describe("tables tool", () => {
  it("returns tables as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = { listTables: vi.fn().mockResolvedValue([{ name: "users", rows: 10 }]) };
    registerTablesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.tables({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.tables[0].name).toBe("users");
    expect(body.count).toBe(1);
  });

  it("passes database parameter to connector", async () => {
    const { server, handlers } = mockServer();
    const conn = { listTables: vi.fn().mockResolvedValue([]) };
    registerTablesTool(server, config, { mysql: conn as any, postgres: conn as any });

    await handlers.tables({ engineId: "mysql-test", database: "other_db" });
    expect(conn.listTables).toHaveBeenCalledWith("mysql-test", expect.anything(), "other_db");
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerTablesTool(server, config, { mysql: {} as any });

    const res = await handlers.tables({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("propagates connector errors", async () => {
    const { server, handlers } = mockServer();
    const conn = { listTables: vi.fn().mockRejectedValue(new Error("Access denied")) };
    registerTablesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.tables({ engineId: "pg-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Access denied");
  });
});