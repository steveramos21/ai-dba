// Integration test — Sprint 9 features (kill-process, replication-status, server-variables, server-status)
// Requires: docker compose up -d (all 5 engines running)
// Kill tests create real victim queries and terminate them.
import mysql from 'mysql2/promise';
import pg from 'pg';
import { Connection as TediousConnection, Request as TediousRequest } from 'tedious';
import oracledb from 'oracledb';
import { MongoClient } from 'mongodb';

import { mysqlConnector } from '../dist/connectors/mysql.js';
import { postgresConnector } from '../dist/connectors/postgres.js';
import { sqlserverConnector } from '../dist/connectors/sqlserver.js';
import { oracleConnector } from '../dist/connectors/oracle.js';
import { mongodbConnector } from '../dist/connectors/mongodb.js';

// Engines with allowWriteOps: true for kill-process tests
const engines = {
  'mysql-test': { type: 'mysql', host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb', allowWriteOps: true },
  'pg-test': { type: 'postgres', url: 'postgresql://postgres@127.0.0.1:15432/testdb', allowWriteOps: true },
  'sqlserver-test': { type: 'sqlserver', url: 'sqlserver://sa:TestPassword123!@127.0.0.1:11433/testdb', allowWriteOps: true },
  'oracle-test': { type: 'oracle', url: 'oracle://testuser:testpassword@127.0.0.1:11521/XEPDB1', allowWriteOps: true },
  'mongodb-test': { type: 'mongodb', url: 'mongodb://testuser:testpassword@127.0.0.1:12017/testdb?authSource=admin', allowWriteOps: true },
};

const connectors = { mysql: mysqlConnector, postgres: postgresConnector, sqlserver: sqlserverConnector, oracle: oracleConnector, mongodb: mongodbConnector };

let passed = 0, failed = 0;
const results = [];

function assert(name, cond, detail = '') {
  const line = cond ? `  PASS  ${name}` : `  FAIL  ${name}  ${detail}`;
  if (cond) passed++; else failed++;
  results.push(line);
  console.log(line); // stream live — a hang must be localizable from the log
}

// Suite watchdog — a hang anywhere must fail loudly instead of swallowing the
// run. (kill-process blocks are additionally wrapped in withTimeout.)
const SUITE_WATCHDOG_MS = 480000;
const suiteWatchdog = setTimeout(() => {
  console.error(`\nFATAL: sprint9 integration suite exceeded ${SUITE_WATCHDOG_MS / 1000}s — aborting (watchdog)`);
  process.exit(1);
}, SUITE_WATCHDOG_MS);
suiteWatchdog.unref();

// ─── Replication Status ──────────────────────────────────────
async function testReplicationStatus(engineId, engineConfig, connector) {
  const label = `[${engineId}] replication-status`;
  try {
    const repl = await connector.listReplicationStatus(engineId, engineConfig);
    assert(`${label} returns object`, typeof repl === 'object' && repl !== null, `got: ${typeof repl}`);
    assert(`${label} has role`, typeof repl.role === 'string', `got: ${typeof repl.role}`);
    assert(`${label} has lagSeconds`, repl.lagSeconds === null || typeof repl.lagSeconds === 'number', `got: ${typeof repl.lagSeconds}`);
    assert(`${label} has status`, ['healthy', 'degraded', 'down', 'not_configured'].includes(repl.status), `got: ${repl.status}`);
    assert(`${label} has errorMessage`, repl.errorMessage === null || typeof repl.errorMessage === 'string', `got: ${typeof repl.errorMessage}`);
    // Standalone test containers should report not_configured
    assert(`${label} standalone = not_configured`, repl.status === 'not_configured', `expected not_configured, got: ${repl.status}`);
  } catch (e) { assert(`${label}`, false, e.message); }
}

// ─── Server Variables ────────────────────────────────────────
async function testServerVariables(engineId, engineConfig, connector) {
  const label = `[${engineId}] server-variables`;
  try {
    const vars = await connector.listServerVariables(engineId, engineConfig);
    assert(`${label} returns array`, Array.isArray(vars), `got: ${typeof vars}`);
    assert(`${label} has results`, vars.length > 0, `empty result`);

    if (vars.length > 0) {
      const v = vars[0];
      assert(`${label} has name`, typeof v.name === 'string', `got: ${typeof v.name}`);
      assert(`${label} has value`, typeof v.value === 'string', `got: ${typeof v.value}`);
    }
  } catch (e) { assert(`${label}`, false, e.message); }
}

// ─── Server Status ───────────────────────────────────────────
async function testServerStatus(engineId, engineConfig, connector) {
  const label = `[${engineId}] server-status`;
  try {
    const metrics = await connector.listServerStatus(engineId, engineConfig);
    assert(`${label} returns array`, Array.isArray(metrics), `got: ${typeof metrics}`);
    assert(`${label} has results`, metrics.length > 0, `empty result`);

    if (metrics.length > 0) {
      const m = metrics[0];
      assert(`${label} has name`, typeof m.name === 'string', `got: ${typeof m.name}`);
      assert(`${label} has value`, typeof m.value === 'number' || typeof m.value === 'string', `got: ${typeof m.value}`);
    }
  } catch (e) { assert(`${label}`, false, e.message); }
}

// ─── Kill Process (dry-run only for safety) ──────────────────
async function testKillProcessDryRun(engineId, engineConfig, connector) {
  const label = `[${engineId}] kill-process dry-run`;
  try {
    // Use a non-existent PID for dry-run test — should return not found
    const fakePid = engineConfig.type === 'oracle' ? '99999,99999' : '999999';
    const result = await connector.killProcess(engineId, engineConfig, fakePid, { dryRun: true });
    assert(`${label} returns object`, typeof result === 'object' && result !== null, `got: ${typeof result}`);
    assert(`${label} has wouldKill`, result.wouldKill === true, `got: ${result.wouldKill}`);
    assert(`${label} has command`, typeof result.command === 'string', `got: ${typeof result.command}`);
    assert(`${label} dry-run success=false`, result.success === false, `got: ${result.success}`);
    assert(`${label} not found`, result.found === false, `got: ${result.found}`);
  } catch (e) { assert(`${label}`, false, e.message); }
}

// ─── Kill Process (real kill with victim query) ──────────────
async function testKillProcessReal(engineId, engineConfig, connector) {
  const label = `[${engineId}] kill-process real`;
  const engineType = engineConfig.type;

  try {
    let victimPid = null;

    if (engineType === 'mysql') {
      const conn = await mysql.createConnection({ host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' });
      const victimQuery = conn.query('SELECT SLEEP(30)').catch(() => {}); // killed below — handler from birth
      await new Promise(r => setTimeout(r, 1000));
      const procs = await connector.listProcesses(engineId, engineConfig);
      const victim = procs.find(p => p.query?.includes('SLEEP'));
      if (victim) {
        victimPid = String(victim.pid);
        const dryRun = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: true });
        assert(`${label} dry-run found`, dryRun.found === true, `found: ${dryRun.found}`);
        assert(`${label} dry-run wouldKill`, dryRun.wouldKill === true);
        assert(`${label} dry-run has command`, typeof dryRun.command === 'string');

        const killResult = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: false });
        assert(`${label} kill success`, killResult.success === true, `success: ${killResult.success}, error: ${killResult.error}`);
        assert(`${label} kill found`, killResult.found === true, `found: ${killResult.found}`);
      } else {
        assert(`${label} victim query found in process list`, false, 'SLEEP query not visible in listProcesses');
      }
      try { await victimQuery; } catch {}
      try { await conn.end(); } catch {}

    } else if (engineType === 'postgres') {
      const client = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:15432/testdb' });
      // Termination of this session is EXPECTED (we kill it below). A terminated
      // pg client emits 'error', and an unhandled rejection on the victim query
      // is fatal in Node >=18 — both handlers must exist from birth.
      client.on('error', () => {});
      await client.connect();
      const victimQuery = client.query('SELECT pg_sleep(30)').catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      const procs = await connector.listProcesses(engineId, engineConfig);
      const victim = procs.find(p => p.query?.includes('pg_sleep') && p.pid !== process.pid);
      if (victim) {
        victimPid = String(victim.pid);
        const dryRun = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: true });
        assert(`${label} dry-run found`, dryRun.found === true, `found: ${dryRun.found}`);

        const killResult = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: false });
        assert(`${label} kill success`, killResult.success === true, `success: ${killResult.success}, error: ${killResult.error}`);
      } else {
        assert(`${label} victim query found`, false, 'pg_sleep not visible in process list');
      }
      try { await victimQuery; } catch {}
      try { await client.end(); } catch {}

    } else if (engineType === 'sqlserver') {
      const connConfig = { server: '127.0.0.1', authentication: { type: 'default', options: { userName: 'sa', password: 'TestPassword123!' } }, options: { port: 11433, database: 'testdb', trustServerCertificate: true } };
      const conn = new TediousConnection(connConfig);
      await new Promise((resolve, reject) => {
        conn.on('connect', err => err ? reject(err) : resolve());
        conn.on('error', err => reject(err));
        conn.connect(); // raw tedious connections don't auto-connect — without this the suite hangs forever
      });
      const request = new TediousRequest("WAITFOR DELAY '00:00:30'", () => {});
      // killed below — handler from birth (unhandled rejections are fatal on Node >=18)
      Promise.resolve(conn.execSql(request)).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      const procs = await connector.listProcesses(engineId, engineConfig);
      const victim = procs.find(p => p.command?.includes('WAITFOR') || p.query?.includes('WAITFOR'));
      if (victim) {
        victimPid = String(victim.pid);
        const dryRun = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: true });
        assert(`${label} dry-run found`, dryRun.found === true, `found: ${dryRun.found}`);

        const killResult = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: false });
        assert(`${label} kill success`, killResult.success === true, `success: ${killResult.success}, error: ${killResult.error}`);
      } else {
        assert(`${label} victim query found`, false, 'WAITFOR not visible in process list (may need VIEW SERVER STATE)');
      }
      try { conn.close(); } catch {}

    } else if (engineType === 'oracle') {
      const conn = await oracledb.getConnection({ user: 'testuser', password: 'testpassword', connectString: '127.0.0.1:11521/XEPDB1' });
      const victimPromise = conn.execute('BEGIN DBMS_LOCK.SLEEP(30); END;').catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      const procs = await connector.listProcesses(engineId, engineConfig);
      const victim = procs.find(p => p.serial != null);
      if (victim) {
        victimPid = `${victim.pid},${victim.serial}`;
        const dryRun = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: true });
        assert(`${label} dry-run found`, dryRun.found === true, `found: ${dryRun.found}`);
        assert(`${label} dry-run command`, dryRun.command?.includes('ALTER SYSTEM KILL SESSION'), `got: ${dryRun.command}`);

        const killResult = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: false });
        assert(`${label} kill success`, killResult.success === true, `success: ${killResult.success}, error: ${killResult.error}`);
        if (killResult.notes) assert(`${label} has notes`, typeof killResult.notes === 'string');
      } else {
        assert(`${label} victim session found`, false, 'No user sessions with serial# found in process list');
      }
      try { await victimPromise; } catch {}
      try { await conn.close(); } catch {}

    } else if (engineType === 'mongodb') {
      const client = new MongoClient('mongodb://testuser:testpassword@127.0.0.1:12017/testdb?authSource=admin');
      await client.connect();
      const db = client.db('testdb');
      // Make the scan self-sufficient: ensure at least one document exists (idempotent).
      await db.collection('blocking_test').updateOne({ _id: 'ai-dba-kill-victim' }, { $set: { marker: 'ai-dba-kill-victim' } }, { upsert: true });
      // $where runs one server-side sleep per scanned document. maxTimeMS makes the
      // scan self-terminate even if killOp is ignored, so it can never hang the suite.
      const victimPromise = db.collection('blocking_test')
        .find({ $where: 'sleep(5000) || true' })
        .maxTimeMS(25000)
        .toArray().catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      const procs = await connector.listProcesses(engineId, engineConfig);
      // Match OUR victim by its command marker — "first positive opid" can be any op
      // (internal, or another connection's), making killOp a no-op and hanging cleanup.
      const victim = procs.find(p => p.pid && p.pid > 0 && (p.query?.includes('sleep(5000)') || p.query?.includes('$where')));
      if (victim) {
        victimPid = String(victim.pid);
        const dryRun = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: true });
        assert(`${label} dry-run wouldKill`, dryRun.wouldKill === true, `wouldKill: ${dryRun.wouldKill}`);

        const killResult = await connector.killProcess(engineId, engineConfig, victimPid, { dryRun: false });
        assert(`${label} kill executed`, killResult.success === true || killResult.found === false, `success: ${killResult.success}, found: ${killResult.found}`);
      } else {
        assert(`${label} victim op found`, false, 'No operations visible in currentOp (may need clusterOps privilege)');
      }
      // Bounded cleanup: neither the victim op nor the client close may hang the suite.
      await Promise.race([victimPromise, new Promise(r => setTimeout(r, 15000))]);
      try { await Promise.race([client.close(), new Promise(r => setTimeout(r, 5000))]); } catch {}
    }

    if (!victimPid) {
      assert(`${label} skipped (no victim)`, true);
    }
  } catch (e) { assert(`${label}`, false, e.message); }
}

// ─── Health Check includes replication ───────────────────────
async function testHealthCheckReplication(engineId, engineConfig, connector) {
  const label = `[${engineId}] health-check replication`;
  try {
    const repl = await connector.listReplicationStatus(engineId, engineConfig);
    assert(`${label} returns not_configured`, repl.status === 'not_configured', `got: ${repl.status}`);
  } catch (e) { assert(`${label}`, false, e.message); }
}

// Guard: a harness bug or unreachable DB must fail loudly instead of hanging the suite.
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} — timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('============================================');
  console.log(' AI-DBA Integration — Sprint 9 Features');
  console.log('============================================');

  for (const [engineId, engineConfig] of Object.entries(engines)) {
    const connector = connectors[engineConfig.type];
    console.log(`\n=== [${engineId}] ===`);

    // Read-only tests first
    await testReplicationStatus(engineId, engineConfig, connector);
    await testServerVariables(engineId, engineConfig, connector);
    await testServerStatus(engineId, engineConfig, connector);
    await testHealthCheckReplication(engineId, engineConfig, connector);

    // Kill tests — dry-run is safe, real kill creates+terminates a victim
    await testKillProcessDryRun(engineId, engineConfig, connector);
    try {
      await withTimeout(testKillProcessReal(engineId, engineConfig, connector), 90000, `${engineId} kill-process real`);
    } catch (e) {
      assert(`${engineId} kill-process real did not hang`, false, e.message);
    }
  }

  // Print results
  console.log('\n============================================');
  console.log(' RESULTS');
  console.log('============================================');
  // Per-assert lines stream live via assert(); the summary below is the aggregate.
  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log('============================================\n');

  // Cleanup
  for (const connector of Object.values(connectors)) {
    await connector.closeAllPools();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });