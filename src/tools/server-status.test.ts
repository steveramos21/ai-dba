import { describe, it, expect, vi } from "vitest";
import { registerServerStatusTool } from "./server-status.js";
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

describe("server-status tool", () => {
  it("returns populated metrics list", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listServerStatus: vi.fn().mockResolvedValue([
        { name: "Uptime", value: 3600 },
        { name: "Threads_connected", value: 12 },
        { name: "Queries", value: 45000 },
      ]),
    };
    registerServerStatusTool(server, config, { mysql: conn as any });

    const res = await handlers["server-status"]({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.metrics).toHaveLength(3);
    expect(body.count).toBe(3);
    expect(body.metrics[0].name).toBe("Uptime");
    expect(body.metrics[0].value).toBe(3600);
  });

  it("returns empty array when no privileges", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listServerStatus: vi.fn().mockResolvedValue([]),
    };
    registerServerStatusTool(server, config, { mysql: conn as any });

    const res = await handlers["server-status"]({ engineId: "mysql-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.metrics).toHaveLength(0);
    expect(body.count).toBe(0);
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerServerStatusTool(server, config, { mysql: {} as any });

    const res = await handlers["server-status"]({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("returns error when connector throws", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listServerStatus: vi.fn().mockRejectedValue(new Error("Connection lost")),
    };
    registerServerStatusTool(server, config, { mysql: conn as any });

    const res = await handlers["server-status"]({ engineId: "mysql-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Connection lost");
  });
});