// Cold-start + lazy-import regression guard.
//
// Two checks, both about startup behavior:
//   1. dist static-import scan — no static imports of DB drivers anywhere in
//      dist/**/*.js. Environment-independent; catches eager driver loading
//      regardless of how fast the filesystem is.
//   2. Latency — MCP handshake (initialize -> tools/list) and CLI cold start
//      stay under a threshold. The five drivers cost ~27 s combined on this
//      project's WSL 9p mounts; an eager driver import blows through any
//      sane ceiling.
//
// Thresholds: 8000 ms native, 12000 ms on WSL /mnt/* (9p module resolution is
// ~50x slower and the MCP SDK import alone accounts for ~7 s there). Both
// ceilings still catch an eager driver import with large margin. Override with
// COLDSTART_THRESHOLD_MS; hard abort per measurement via COLDSTART_TIMEOUT_MS.
//
// CI-safe: generates its own throwaway config (config.yaml is gitignored, so
// CI runners don't have one). Pools are lazy — tools/list never touches a DB.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const isNineP = /^\/mnt\//.test(process.cwd());
const DEFAULT_THRESHOLD_MS = isNineP ? 12000 : 8000;
const THRESHOLD_MS = Number(process.env.COLDSTART_THRESHOLD_MS || DEFAULT_THRESHOLD_MS);
const TIMEOUT_MS = Number(process.env.COLDSTART_TIMEOUT_MS || 90000);
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// ─── Check 1: static driver imports in dist ──────────────────
const DRIVER_RE = /(?:from\s+|require\()\s*["'](mysql2(?:\/promise)?|pg|tedious|oracledb|mongodb)["']/;

function scanDist(dir, hits = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scanDist(p, hits);
    else if (e.name.endsWith(".js")) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("//")) continue;
        if (DRIVER_RE.test(t)) hits.push(`${p.replace(DIST + "/", "dist/")}: ${t.slice(0, 110)}`);
      }
    }
  }
  return hits;
}

const staticHits = scanDist(DIST);

// ─── Check 2: latency ────────────────────────────────────────
const cfgDir = mkdtempSync(join(tmpdir(), "ai-dba-coldstart-"));
const cfgPath = join(cfgDir, "config.yaml");
writeFileSync(
  cfgPath,
  "engines:\n  coldstart-probe:\n    type: mysql\n    host: 127.0.0.1\n    port: 3306\n"
);

function measureMcpHandshake() {
  return new Promise((resolve) => {
    const child = spawn("node", ["dist/index.js", "--config", cfgPath, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const t0 = performance.now();
    let buf = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, ms: performance.now() - t0, error: `no tools/list reply within ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS
    );

    child.on("error", (err) => finish({ ok: false, ms: performance.now() - t0, error: err.message }));

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        }
        if (msg.id === 2) {
          finish({ ok: true, ms: performance.now() - t0, tools: msg.result?.tools?.length ?? 0 });
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coldstart", version: "0" } },
      }) + "\n"
    );
  });
}

// CLI cold start: the unknown-engine error path exercises config load + the
// connector map without touching a database.
function measureCli() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn("node", ["dist/index.js", "--config", cfgPath, "health-check", "__coldstart_probe__"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, ms: performance.now() - t0, error: `CLI did not exit within ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, ms: performance.now() - t0, error: err.message });
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve({ ok: true, ms: performance.now() - t0 });
    });
  });
}

const mcp = await measureMcpHandshake();
const cli = await measureCli();

try {
  rmSync(cfgDir, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

console.log(
  `Filesystem: ${isNineP ? "WSL /mnt (9p) — raised ceiling" : "native"}  |  threshold: ${THRESHOLD_MS} ms`
);

const results = [
  {
    name: "dist static driver-import scan",
    ms: 0,
    ok: staticHits.length === 0,
    detail: staticHits.length ? staticHits.join(" | ") : "clean",
  },
  {
    name: "MCP tools/list",
    ms: mcp.ms,
    ok: mcp.ok && mcp.ms <= THRESHOLD_MS,
    detail: mcp.ok ? `${mcp.tools} tools` : mcp.error,
  },
  {
    name: "CLI cold start (unknown engine)",
    ms: cli.ms,
    ok: cli.ok && cli.ms <= THRESHOLD_MS,
    detail: cli.ok ? "" : cli.error,
  },
];

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${Math.round(r.ms)} ms (threshold ${THRESHOLD_MS} ms)` +
      (r.detail ? `  [${r.detail}]` : "")
  );
}
process.exit(failed > 0 ? 1 : 0);
