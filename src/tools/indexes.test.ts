import { describe, it, expect, vi } from "vitest";
import { registerIndexesTool } from "./indexes.js";
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

describe("indexes tool", () => {
  it("returns indexes as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = { listIndexes: vi.fn().mockResolvedValue([
      { name: "PRIMARY", table: "users", columns: ["id"], isUnique: true, isPrimary: true, type: "BTREE" },
    ]) };
    registerIndexesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.indexes({ engineId: "mysql-test", table: "users" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.indexes[0].name).toBe("PRIMARY");
    expect(body.indexes[0].isPrimary).toBe(true);
    expect(body.count).toBe(1);
  });

  it("passes database parameter to connector", async () => {
    const { server, handlers } = mockServer();
    const conn = { listIndexes: vi.fn().mockResolvedValue([]) };
    registerIndexesTool(server, config, { mysql: conn as any, postgres: conn as any });

    await handlers.indexes({ engineId: "mysql-test", table: "users", database: "other_db" });
    expect(conn.listIndexes).toHaveBeenCalledWith("mysql-test", expect.anything(), "users", "other_db");
  });

  it("returns message when no indexes found", async () => {
    const { server, handlers } = mockServer();
    const conn = { listIndexes: vi.fn().mockResolvedValue([]) };
    registerIndexesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.indexes({ engineId: "mysql-test", table: "heap_table" });
    const body = JSON.parse(res.content[0].text);
    expect(body.count).toBe(0);
    expect(body.message).toContain("No indexes found");
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerIndexesTool(server, config, { mysql: {} as any });

    const res = await handlers.indexes({ engineId: "ghost", table: "users" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });
});