import { describe, it, expect } from "vitest";
import { parseOracleUrl } from "./oracle.js";

describe("parseOracleUrl", () => {
  it("extracts connection components", () => {
    const r = parseOracleUrl("oracle://scott:tiger@10.0.0.1:1521/ORCL");
    expect(r.user).toBe("scott");
    expect(r.password).toBe("tiger");
    expect(r.connectString).toBe("10.0.0.1:1521/ORCL");
  });

  it("uses default port 1521 when not specified", () => {
    const r = parseOracleUrl("oracle://scott:tiger@host/XE");
    expect(r.connectString).toBe("host:1521/XE");
    expect(r.user).toBe("scott");
  });

  it("handles URL-encoded passwords", () => {
    const r = parseOracleUrl("oracle://scott:p%40ss%21@host:1521/ORCL");
    expect(r.password).toBe("p@ss!");
  });

  it("throws on invalid URL", () => {
    expect(() => parseOracleUrl("not-a-url")).toThrow("Invalid Oracle URL");
  });
});