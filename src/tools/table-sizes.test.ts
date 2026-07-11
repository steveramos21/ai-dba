import { describe, it, expect, vi } from "vitest";
import { registerTableSizesTool } from "./table-sizes.js";
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

describe("table-sizes tool", () => {
  it("returns table sizes as JSON on happy path", async () => {
    const { server, handlers } = mockServer();
    const conn = {
      listTableSizes: vi.fn().mockResolvedValue([
        { name: "orders", rows: 100000, dataSizeBytes: 5000000, indexSizeBytes: 2000000, totalSizeBytes: 7000000 },
        { name: "users", rows: 5000, dataSizeBytes: 300000, indexSizeBytes: 100000, totalSizeBytes: 400000 },
      ]),
    };
    registerTableSizesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["table-sizes"]({ engineId: "mysql-test" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0].text);
    expect(body.tableSizes[0].name).toBe("orders");
    expect(body.tableSizes[0].totalSizeBytes).toBe(7000000);
    expect(body.count).toBe(2);
  });

  it("passes database parameter to connector", async () => {
    const { server, handlers } = mockServer();
    const conn = { listTableSizes: vi.fn().mockResolvedValue([]) };
    registerTableSizesTool(server, config, { mysql: conn as any, postgres: conn as any });

    await handlers["table-sizes"]({ engineId: "pg-test", database: "other_schema" });
    expect(conn.listTableSizes).toHaveBeenCalledWith("pg-test", expect.anything(), "other_schema");
  });

  it("returns error for unknown engineId", async () => {
    const { server, handlers } = mockServer();
    registerTableSizesTool(server, config, { mysql: {} as any });

    const res = await handlers["table-sizes"]({ engineId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown engine");
  });

  it("propagates connector errors", async () => {
    const { server, handlers } = mockServer();
    const conn = { listTableSizes: vi.fn().mockRejectedValue(new Error("Access denied")) };
    registerTableSizesTool(server, config, { mysql: conn as any, postgres: conn as any });

    const res = await handlers["table-sizes"]({ engineId: "mysql-test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Access denied");
  });
});