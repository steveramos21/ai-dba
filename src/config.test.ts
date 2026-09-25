import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SAFETY_DEFAULTS,
  resolveRowLimit,
  resolveQueryTimeoutMs,
  resolveConnectTimeoutMs,
  timeoutConfigFingerprint,
  loadConfig,
} from "./config.js";

// Sprint 10 Part 2a — Task 1.1
// The three safety limits (rowLimit / queryTimeoutMs / connectTimeoutMs) are
// optional per-engine config fields with code defaults. Resolution order is:
// code default -> per-engine config override. Non-numeric / non-positive
// values fail loud at load time (never a silent fallback to a default the
// operator did not choose).

function writeTempConfig(yaml: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ai-dba-config-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BASE = "engines:\n  e1:\n    type: mysql\n    url: mysql://user@localhost:3306/db\n";

describe("safety-limit defaults (code defaults)", () => {
  it("resolves code defaults when no overrides are present", () => {
    const config = { type: "mysql" as const, url: "mysql://user@localhost:3306/db" };
    expect(SAFETY_DEFAULTS.rowLimit).toBe(1000);
    expect(SAFETY_DEFAULTS.queryTimeoutMs).toBe(30000);
    expect(SAFETY_DEFAULTS.connectTimeoutMs).toBe(10000);
    expect(resolveRowLimit(config)).toBe(1000);
    expect(resolveQueryTimeoutMs(config)).toBe(30000);
    expect(resolveConnectTimeoutMs(config)).toBe(10000);
  });

  it("loadConfig leaves the fields undefined when absent (resolvers supply defaults)", () => {
    const { path, cleanup } = writeTempConfig(BASE);
    try {
      const cfg = loadConfig(path);
      const engine = cfg.engines.e1;
      expect(engine.rowLimit).toBeUndefined();
      expect(engine.queryTimeoutMs).toBeUndefined();
      expect(engine.connectTimeoutMs).toBeUndefined();
      expect(resolveRowLimit(engine)).toBe(1000);
      expect(resolveQueryTimeoutMs(engine)).toBe(30000);
      expect(resolveConnectTimeoutMs(engine)).toBe(10000);
    } finally {
      cleanup();
    }
  });
});

describe("safety-limit overrides", () => {
  it("resolvers return explicit overrides verbatim", () => {
    const config = {
      type: "postgres" as const,
      url: "postgresql://user@localhost:5432/db",
      rowLimit: 250,
      queryTimeoutMs: 5000,
      connectTimeoutMs: 2000,
    };
    expect(resolveRowLimit(config)).toBe(250);
    expect(resolveQueryTimeoutMs(config)).toBe(5000);
    expect(resolveConnectTimeoutMs(config)).toBe(2000);
  });

  it("loadConfig accepts valid overrides and keeps them on the engine", () => {
    const yaml = BASE +
      "    rowLimit: 500\n" +
      "    queryTimeoutMs: 15000\n" +
      "    connectTimeoutMs: 3000\n";
    const { path, cleanup } = writeTempConfig(yaml);
    try {
      const cfg = loadConfig(path);
      expect(cfg.engines.e1.rowLimit).toBe(500);
      expect(cfg.engines.e1.queryTimeoutMs).toBe(15000);
      expect(cfg.engines.e1.connectTimeoutMs).toBe(3000);
      expect(resolveRowLimit(cfg.engines.e1)).toBe(500);
      expect(resolveQueryTimeoutMs(cfg.engines.e1)).toBe(15000);
      expect(resolveConnectTimeoutMs(cfg.engines.e1)).toBe(3000);
    } finally {
      cleanup();
    }
  });
});

describe("safety-limit validation (fail loud)", () => {
  const cases: Array<{ field: string; literal: string }> = [
    { field: "rowLimit", literal: '"fast"' },        // string, not a number
    { field: "rowLimit", literal: '"5"' },           // numeric-looking string is still not a number
    { field: "rowLimit", literal: "" },              // YAML empty value -> null -> fail loud
    { field: "rowLimit", literal: "1.5" },           // fractional
    { field: "rowLimit", literal: "0" },             // not positive
    { field: "queryTimeoutMs", literal: "0" },
    { field: "queryTimeoutMs", literal: "-100" },
    { field: "connectTimeoutMs", literal: '"10s"' },
    { field: "connectTimeoutMs", literal: "-1" },
  ];

  for (const { field, literal } of cases) {
    it(`rejects ${field}: ${literal} with a clear message`, () => {
      const { path, cleanup } = writeTempConfig(BASE + `    ${field}: ${literal}\n`);
      try {
        expect(() => loadConfig(path)).toThrow(new RegExp(`${field}.*positive integer`));
        // The message must name the offending engine so multi-engine configs
        // point straight at the bad entry.
        expect(() => loadConfig(path)).toThrow(/Engine "e1"/);
      } finally {
        cleanup();
      }
    });
  }

  it("accepts the field when it is a positive integer", () => {
    const { path, cleanup } = writeTempConfig(BASE + "    rowLimit: 1\n");
    try {
      const cfg = loadConfig(path);
      expect(cfg.engines.e1.rowLimit).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// Task 1.3: the fingerprint decides whether a cached pool/connection can be
// reused. Equality for equal configs; inequality when a timeout override
// changes; and non-timeout fields must NOT force needless rebuilds.
describe("timeoutConfigFingerprint (Task 1.3)", () => {
  const base = { type: "mysql" as const, url: "mysql://user@localhost:3306/db" };

  it("is stable for equal configs", () => {
    expect(timeoutConfigFingerprint(base)).toBe(timeoutConfigFingerprint({ ...base }));
  });

  it("changes when a timeout override changes", () => {
    expect(timeoutConfigFingerprint({ ...base, queryTimeoutMs: 5000 })).not.toBe(timeoutConfigFingerprint(base));
    expect(timeoutConfigFingerprint({ ...base, connectTimeoutMs: 20000 })).not.toBe(timeoutConfigFingerprint(base));
  });

  it("ignores fields that do not affect pool construction", () => {
    expect(timeoutConfigFingerprint({ ...base, database: "other" })).toBe(timeoutConfigFingerprint(base));
  });
});
