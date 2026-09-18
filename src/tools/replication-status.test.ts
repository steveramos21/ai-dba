import { describe, it, expect, vi } from "vitest";
import { registerReplicationStatusTool } from "./replication-status.js";
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

describe("replication-status tool", () => {
  it("returns healthy replication status", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listReplicationStatus: vi.fn().mockResolvedValue({
        role: "replica", lagSeconds: 0, status: "healthy", errorMessage: null,
      }),
    };
    registerReplicationStatusTool(server, config, { mysql: conn as any });

    const res = await handlers["replication-status"]({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.role).toBe("replica");
    expect(body.status).toBe("healthy");
    expect(body.lagSeconds).toBe(0);
    expect(body.errorMessage).toBeNull();
  });

  it("returns degraded status with lag", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listReplicationStatus: vi.fn().mockResolvedValue({
        role: "replica", lagSeconds: 120, status: "degraded", errorMessage: null,
      }),
    };
    registerReplicationStatusTool(server, config, { mysql: conn as any });

    const res = await handlers["replication-status"]({ engineId: "mysql-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("degraded");
    expect(body.lagSeconds).toBe(120);
  });

  it("returns down status with error message", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listReplicationStatus: vi.fn().mockResolvedValue({
        role: "replica", lagSeconds: null, status: "down", errorMessage: "IO thread stopped",
      }),
    };
    registerReplicationStatusTool(server, config, { mysql: conn as any });

    const res = await handlers["replication-status"]({ engineId: "mysql-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("down");
    expect(body.errorMessage).toBe("IO thread stopped");
  });

  it("returns not_configured status", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listReplicationStatus: vi.fn().mockResolvedValue({
        role: "none", lagSeconds: null, status: "not_configured", errorMessage: null,
      }),
    };
    registerReplicationStatusTool(server, config, { postgres: conn as any });

    const res = await handlers["replication-status"]({ engineId: "pg-test" });
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("not_configured");
    expect(body.role).toBe("none");
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerReplicationStatusTool(server, config, { mysql: {} as any });

    const res = await handlers["replication-status"]({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });
});