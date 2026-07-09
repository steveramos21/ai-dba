import { describe, it, expect, vi } from "vitest";
import { registerProcessesTool } from "./processes.js";
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

describe("processes tool", () => {
  it("returns processes as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = { listProcesses: vi.fn().mockResolvedValue([
      { pid: 101, user: "root", host: "localhost", database: "testdb", command: "Sleep", time: 5, state: null, query: null },
    ]) };
    registerProcessesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.processes({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.processes[0].pid).toBe(101);
    expect(body.count).toBe(1);
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerProcessesTool(server, config, { mysql: {} as any });

    const res = await handlers.processes({ engineId: "ghost" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("returns error for unsupported engine type", async () => {
    const { server, handlers } = mockServer();
    registerProcessesTool(server, config, { mysql: {} as any });

    const res = await handlers.processes({ engineId: "pg-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No connector registered");
  });

  it("propagates connector errors", async () => {
    const { server, handlers } = mockServer();
    const conn = { listProcesses: vi.fn().mockRejectedValue(new Error("Process list disabled")) };
    registerProcessesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers.processes({ engineId: "mysql-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Process list disabled");
  });
});