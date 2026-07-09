import { describe, it, expect, vi } from "vitest";
import { registerDatabasesTool } from "./databases.js";
import type { AiDbaConfig } from "../config.js";

// Minimal mock server — captures handler registrations by tool name
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

describe("databases tool", () => {
  it("returns databases as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = { listDatabases: vi.fn().mockResolvedValue([{ name: "testdb", charset: "utf8" }]) };
    registerDatabasesTool(server, config, { mysql: conn as any });

    const res = await handlers.databases({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.databases[0].name).toBe("testdb");
    expect(body.count).toBe(1);
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerDatabasesTool(server, config, { mysql: {} as any });

    const res = await handlers.databases({ engineId: "ghost" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("returns error for unsupported engine type", async () => {
    const { server, handlers } = mockServer();
    registerDatabasesTool(server, config, { mysql: {} as any });

    const res = await handlers.databases({ engineId: "pg-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No connector registered");
  });

  it("propagates connector errors", async () => {
    const { server, handlers } = mockServer();
    const conn = { listDatabases: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    registerDatabasesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.databases({ engineId: "mysql-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("ECONNREFUSED");
  });
});