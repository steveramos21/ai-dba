import { describe, it, expect, vi } from "vitest";
import { registerKillProcessTool } from "./kill-process.js";
import type { AiDbaConfig } from "../config.js";

function mockServer() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<any>> = {};
  return {
    server: { tool: (n: string, _d: string, _s: unknown, fn: any) => { handlers[n] = fn; } } as any,
    handlers,
  };
}

const baseConfig: AiDbaConfig = {
  engines: {
    "mysql-test": { type: "mysql", url: "mysql://root:***@localhost/db", allowWriteOps: true },
    "mysql-readonly": { type: "mysql", url: "mysql://root:***@localhost/db" },
    "oracle-test": { type: "oracle", url: "oracle://***@localhost/XE", allowWriteOps: true },
  },
};

describe("kill-process tool", () => {
  it("returns dry-run proposal when confirm is not set", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      killProcess: vi.fn().mockResolvedValue({
        success: false, found: true, wouldKill: true, pid: "42",
        engineId: "mysql-test", user: "app_user", database: "testdb",
        duration: "5s", query: "SELECT SLEEP(60)", command: "KILL 42",
      }),
    };
    registerKillProcessTool(server, baseConfig, { mysql: conn as any });

    const res = await handlers["kill-process"]({ engineId: "mysql-test", pid: "42" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.proposal).toBeDefined();
    expect(body.proposal.wouldKill).toBe(true);
    expect(body.proposal.command).toBe("KILL 42");
    expect(body.message).toContain("Dry-run");
    expect(conn.killProcess).toHaveBeenCalledWith("mysql-test", expect.anything(), "42", { dryRun: true });
  });

  it("executes kill when confirm=true", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      killProcess: vi.fn().mockResolvedValue({
        success: true, found: true, pid: "42", engineId: "mysql-test",
        command: "KILL 42", killedAt: "2025-01-15T03:14:22Z",
      }),
    };
    registerKillProcessTool(server, baseConfig, { mysql: conn as any });

    const res = await handlers["kill-process"]({ engineId: "mysql-test", pid: "42", confirm: true });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.found).toBe(true);
    expect(body.killedAt).toBeDefined();
    expect(conn.killProcess).toHaveBeenCalledWith("mysql-test", expect.anything(), "42", { dryRun: false });
  });

  it("returns error when allowWriteOps is not set", async () => {
    const { server, handlers } = mockServer();
    const conn = { killProcess: vi.fn() };
    registerKillProcessTool(server, baseConfig, { mysql: conn as any });

    const res = await handlers["kill-process"]({ engineId: "mysql-readonly", pid: "42" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Write operations disabled");
    expect(conn.killProcess).not.toHaveBeenCalled();
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerKillProcessTool(server, baseConfig, { mysql: {} as any });

    const res = await handlers["kill-process"]({ engineId: "nope", pid: "42" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("handles process not found with found:false", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      killProcess: vi.fn().mockResolvedValue({
        success: true, found: false, pid: "999", engineId: "mysql-test",
        command: "KILL 999", killedAt: "2025-01-15T03:14:22Z",
        notes: "Process not found — may have terminated independently",
      }),
    };
    registerKillProcessTool(server, baseConfig, { mysql: conn as any });

    const res = await handlers["kill-process"]({ engineId: "mysql-test", pid: "999", confirm: true });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.found).toBe(false);
    expect(body.notes).toContain("not found");
  });

  it("handles kill failure with isError", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      killProcess: vi.fn().mockResolvedValue({
        success: false, found: true, pid: "42", engineId: "mysql-test",
        command: "KILL 42", error: "Permission denied",
      }),
    };
    registerKillProcessTool(server, baseConfig, { mysql: conn as any });

    const res = await handlers["kill-process"]({ engineId: "mysql-test", pid: "42", confirm: true });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Permission denied");
  });
});