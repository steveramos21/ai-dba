import { describe, it, expect } from "vitest";
import { parseSqlServerUrl } from "./sqlserver.js";

// Unit tests cover the pure function only.
// Connector methods (listDatabases, listTables, etc.) are validated via
// integration tests against a live SQL Server Docker container.

describe("parseSqlServerUrl", () => {
  it("extracts connection components", () => {
    const r = parseSqlServerUrl("sqlserver://sa:pass@10.0.0.1:1433/mydb");
    expect(r.server).toBe("10.0.0.1");
    expect(r.port).toBe(1433);
    expect(r.userName).toBe("sa");
    expect(r.password).toBe("pass");
    expect(r.database).toBe("mydb");
  });

  it("uses defaults for missing port", () => {
    const r = parseSqlServerUrl("sqlserver://sa:pass@host/db");
    expect(r.port).toBe(1433);
    expect(r.userName).toBe("sa");
  });

  it("handles URL-encoded passwords", () => {
    const r = parseSqlServerUrl("sqlserver://sa:p%40ss%21w0rd@host:1433/db");
    expect(r.password).toBe("p@ss!w0rd");
  });

  it("throws on invalid URL", () => {
    expect(() => parseSqlServerUrl("not-a-url")).toThrow("Invalid SQL Server URL");
  });
});