// Cold-start regression test — measures MCP handshake time and CLI cold start.
// Usage: node test/mcp-coldstart.mjs
// Env:   COLDSTART_THRESHOLD_MS (default 8000) — fail above this
//        COLDSTART_TIMEOUT_MS   (default 90000) — abort a measurement stuck this long
//
// The MCP handshake (initialize -> tools/list) is what EVERY agent session pays
// before the first tool is usable, and CLI startup is what every scripted DBA
// action pays. Both must stay fast: connector driver modules load on first
// connection, never at startup.
//
// CI-safe: this script generates its own throwaway config (config.yaml is
// gitignored, so CI runners don't have one). Pools are lazy, so tools/list
// never touches a database.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const THRESHOLD_MS = Number(process.env.COLDSTART_THRESHOLD_MS || 8000);
const TIMEOUT_MS = Number(process.env.COLDSTART_TIMEOUT_MS || 90000);

// Throwaway config — one dummy engine; never connected (pools are lazy).
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

const results = [
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
