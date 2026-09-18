import { describe, it, expect, vi } from "vitest";
import { registerHealthCheckTool } from "./health-check.js";
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

describe("health-check tool", () => {
  it("returns healthy status when all checks pass", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      query: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
      getBlockingChains: vi.fn().mockResolvedValue([]),
      listProcesses: vi.fn().mockResolvedValue([{ pid: 1 }, { pid: 2 }]),
      listSlowQueries: vi.fn().mockResolvedValue([]),
      listReplicationStatus: vi.fn().mockResolvedValue({ role: "none", lagSeconds: null, status: "not_configured", errorMessage: null }),
    };
    registerHealthCheckTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["health-check"]({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("healthy");
    expect(body.engineId).toBe("mysql-test");
    expect(body.engineType).toBe("mysql");
    expect(body.checks).toHaveLength(5);
    expect(body.checks[0].name).toBe("connectivity");
    expect(body.checks[0].status).toBe("pass");
    expect(body.checks[1].name).toBe("blocking");
    expect(body.checks[1].status).toBe("pass");
    expect(body.checks[2].name).toBe("processes");
    expect(body.checks[2].status).toBe("pass");
    expect(body.checks[3].name).toBe("slow-queries");
    expect(body.checks[3].status).toBe("pass");
    expect(body.checks[4].name).toBe("replication");
    expect(body.checks[4].status).toBe("skip");
  });

  it("returns critical status when blocking chains exist", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      query: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
      getBlockingChains: vi.fn().mockResolvedValue([{ blocking_pid: 1, blocked_pid: 2 }]),
      listProcesses: vi.fn().mockResolvedValue([]),
      listSlowQueries: vi.fn().mockResolvedValue([]),
      listReplicationStatus: vi.fn().mockResolvedValue({ role: "none", lagSeconds: null, status: "not_configured", errorMessage: null }),
    };
    registerHealthCheckTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["health-check"]({ engineId: "mysql-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("critical");
    expect(body.checks[1].status).toBe("fail");
    expect(body.checks[1].value).toBe(1);
  });

  it("returns warning status when slow queries found", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      query: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
      getBlockingChains: vi.fn().mockResolvedValue([]),
      listProcesses: vi.fn().mockResolvedValue([]),
      listSlowQueries: vi.fn().mockResolvedValue([{ id: "q1", query: "SELECT * FROM x", totalExecutionTimeMs: 5000 }]),
      listReplicationStatus: vi.fn().mockResolvedValue({ role: "none", lagSeconds: null, status: "not_configured", errorMessage: null }),
    };
    registerHealthCheckTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["health-check"]({ engineId: "pg-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("warning");
    expect(body.checks[3].status).toBe("warn");
    expect(body.checks[3].value).toBe(1);
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerHealthCheckTool(server, config, { mysql: {} as any });

    const res = await handlers["health-check"]({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });
});