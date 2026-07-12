import { describe, it, expect, vi } from "vitest";
import { registerServerVariablesTool } from "./server-variables.js";
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
  },
};

describe("server-variables tool", () => {
  it("returns populated variables list", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listServerVariables: vi.fn().mockResolvedValue([
        { name: "max_connections", value: "151" },
        { name: "long_query_time", value: "10.000000" },
        { name: "innodb_buffer_pool_size", value: "134217728", description: "Size of the InnoDB buffer pool" },
      ]),
    };
    registerServerVariablesTool(server, config, { mysql: conn as any });

    const res = await handlers["server-variables"]({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.variables).toHaveLength(3);
    expect(body.count).toBe(3);
    expect(body.variables[0].name).toBe("max_connections");
    expect(body.variables[0].value).toBe("151");
    expect(body.variables[2].description).toBeDefined();
  });

  it("returns empty array when no privileges", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listServerVariables: vi.fn().mockResolvedValue([]),
    };
    registerServerVariablesTool(server, config, { mysql: conn as any });

    const res = await handlers["server-variables"]({ engineId: "mysql-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.variables).toHaveLength(0);
    expect(body.count).toBe(0);
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerServerVariablesTool(server, config, { mysql: {} as any });

    const res = await handlers["server-variables"]({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("returns error when connector throws", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listServerVariables: vi.fn().mockRejectedValue(new Error("Connection lost")),
    };
    registerServerVariablesTool(server, config, { mysql: conn as any });

    const res = await handlers["server-variables"]({ engineId: "mysql-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Connection lost");
  });
});