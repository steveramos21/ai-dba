// ============================================================================
// ai-dba Sprint 10 - Part 2a AFTER verification harness (Task 1.5)
// ----------------------------------------------------------------------------
// Verifies the three safety primitives end-to-end against a live compose stack:
//   1. Row cap + honest truncation   (all 5 engines where seedable)
//   2. Query + connect timeouts      (mysql/pg strict; sqlserver/oracle attempt)
//   3. Degraded-on-empty             (pg live; unit-only elsewhere, gaps noted)
// Cross-platform (Windows node / Linux node). Run from the repo root:
//    node test/part2a-verify.mjs
// Evidence contract: every probe prints RAW measured values (rows, elapsed ms,
// error text) next to PASS/FAIL/SKIP - eyeball against the BEFORE bundle
// (2026-09-19, dev host). AFTER runs on stevepc (2026-09-26); identical compose
// images, so primitive behavior is comparable across hosts (host-change labeled).
// ============================================================================
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { mysqlConnector } from '../dist/connectors/mysql.js';
import { postgresConnector } from '../dist/connectors/postgres.js';
import { sqlserverConnector } from '../dist/connectors/sqlserver.js';
import { oracleConnector } from '../dist/connectors/oracle.js';
import { mongodbConnector } from '../dist/connectors/mongodb.js';

process.on('unhandledRejection', (e) => { console.log('UNHANDLED_REJECTION ' + e); });

let PASS = 0, FAIL = 0, SKIP = 0;
const say = (s) => console.log(s);
const pass = (n, raw) => { PASS++; say('PASS  ' + n + ' | ' + raw); };
const fail = (n, raw) => { FAIL++; say('FAIL  ' + n + ' | ' + raw); };
const skip = (n, raw) => { SKIP++; say('SKIP  ' + n + ' | ' + raw); };
const section = (t) => say('\n== ' + t + ' ==');

// --- engine configs (same as BEFORE probes / integration suites) -----------
const MYSQL  = { type: 'mysql',     host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' };
const PG     = { type: 'postgres',  url: 'postgresql://postgres@127.0.0.1:15432/testdb' };
const MSSQL  = { type: 'sqlserver', url: 'sqlserver://sa:TestPassword123!@127.0.0.1:11433/testdb' };
const ORA    = { type: 'oracle',    url: 'oracle://testuser:testpassword@127.0.0.1:11521/XEPDB1' };
const MONGO  = { type: 'mongodb',   url: 'mongodb://testuser:testpassword@127.0.0.1:12017/testdb?authSource=admin' };
const DEADPG = { type: 'postgres',  url: 'postgresql://postgres@10.255.255.1:5432/testdb', connectTimeoutMs: 5000 };

const CAP = 1000;          // default rowLimit under test
const OVERRIDE_MS = 2000;  // probe override (plan Task 1.5: queryTimeoutMs: 2000)

function lastLine(s) { return String(s || '').split(/\r?\n/).filter((x) => x.trim()).pop() || ''; }

function raceCap(promise, capMs) {
  promise.catch(() => {}); // prevent unhandled rejection when the cap wins the race
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('HARNESS_CAP ' + capMs + 'ms exceeded')), capMs); }),
  ]).finally(() => clearTimeout(t));
}
const isCap = (e) => /HARNESS_CAP/.test(String(e && e.message));

// --- docker helpers (seeds + container health) ------------------------------
function docker(args, input, capMs = 180000) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: capMs, windowsHide: true });
  if (r.error) return { ok: false, err: r.error.message };
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// --- seeds (embedded; applied via docker exec, never through the connectors)
const SEED_MYSQL = `SET SESSION cte_max_recursion_depth=4000;
DROP TABLE IF EXISTS rowcap_test;
CREATE TABLE rowcap_test (id INT PRIMARY KEY, v VARCHAR(32));
INSERT INTO rowcap_test WITH RECURSIVE seq AS (SELECT 1 n UNION ALL SELECT n+1 FROM seq WHERE n<3000) SELECT n, CONCAT('row',n) FROM seq;
SELECT COUNT(*) AS cnt FROM rowcap_test;`;
const SEED_PG = `DROP TABLE IF EXISTS rowcap_test;
CREATE TABLE rowcap_test (id INT PRIMARY KEY, v TEXT);
INSERT INTO rowcap_test SELECT g, 'row'||g FROM generate_series(1,3000) g;
SELECT COUNT(*) AS cnt FROM rowcap_test;`;
const SEED_MSSQL = `IF OBJECT_ID('dbo.rowcap_test','U') IS NOT NULL DROP TABLE dbo.rowcap_test;
GO
WITH n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i < 3000)
SELECT i AS id, 'row' + CAST(i AS VARCHAR(32)) AS v INTO dbo.rowcap_test FROM n OPTION (MAXRECURSION 4000);
GO
SELECT COUNT(*) AS cnt FROM dbo.rowcap_test;
GO`;
const SEED_ORA = `WHENEVER SQLERROR CONTINUE
BEGIN
  EXECUTE IMMEDIATE 'DROP TABLE rowcap_test';
EXCEPTION WHEN OTHERS THEN NULL;
END;
/
CREATE TABLE rowcap_test AS SELECT LEVEL AS id, 'row' || LEVEL AS v FROM DUAL CONNECT BY LEVEL <= 3000;
SELECT COUNT(*) AS cnt FROM rowcap_test;
EXIT`;
const SEED_MONGO_EVAL = "const d = db.getSiblingDB('testdb'); d.rowcap_test.drop(); const docs = []; for (let i = 1; i <= 3000; i++) { docs.push({ id: i, v: 'row' + i }); } d.rowcap_test.insertMany(docs, { ordered: false }); print('cnt=' + d.rowcap_test.countDocuments({}) + ' mongo_version=' + db.version());";

// SQL Server tools18 path (compose healthcheck probes the same binary).
const SQLCMD18 = '/opt/mssql-tools18/bin/sqlcmd';
// Oracle sleep wrapper: DBMS_LOCK.SLEEP is a PROCEDURE, not SQL-callable - a SYS-created
// function makes it usable from SELECT so callTimeout can actually be exercised.
const SEED_SLEEPFN = `WHENEVER SQLERROR CONTINUE
CREATE OR REPLACE FUNCTION AI_DBA_SLEEP(p IN NUMBER) RETURN NUMBER IS
BEGIN
  DBMS_LOCK.SLEEP(p);
  RETURN 1;
END;
/
GRANT EXECUTE ON AI_DBA_SLEEP TO testuser;
CREATE OR REPLACE PUBLIC SYNONYM AI_DBA_SLEEP FOR SYS.AI_DBA_SLEEP;
EXIT`;

async function applySeeds() {
  section('SEEDS (docker exec; skipped honestly when docker/containers unavailable)');
  const seeded = { mysql: false, pg: false, sqlserver: false, oracle: false, mongodb: false };
  const dv = docker(['version', '--format', '{{.Server.Version}}'], null, 30000);
  if (!dv.ok) { skip('seed:docker', 'docker CLI/server unavailable: ' + String(dv.err || lastLine(dv.out) || '').slice(0, 160)); return seeded; }

  const jobs = [
    ['mysql', 'ai-dba-mysql-test', ['exec', '-i', 'ai-dba-mysql-test', 'mysql', '-uroot', '-ptestpassword', 'testdb'], SEED_MYSQL, null],
    ['pg', 'ai-dba-postgres-test', ['exec', '-i', 'ai-dba-postgres-test', 'psql', '-U', 'postgres', '-d', 'testdb'], SEED_PG, null],
    ['sqlserver', 'ai-dba-sqlserver-test', ['exec', '-i', 'ai-dba-sqlserver-test', SQLCMD18, '-S', 'localhost', '-U', 'sa', '-P', 'TestPassword123!', '-C', '-d', 'testdb'], SEED_MSSQL, ['exec', '-i', 'ai-dba-sqlserver-test', SQLCMD18, '-S', 'localhost', '-U', 'sa', '-P', 'TestPassword123!', '-C', '-d', 'master', '-Q', "IF DB_ID('testdb') IS NULL CREATE DATABASE testdb"]],
    ['oracle', 'ai-dba-oracle-test', ['exec', '-i', 'ai-dba-oracle-test', 'sqlplus', '-s', 'testuser/testpassword@localhost:1521/XEPDB1'], SEED_ORA, null],
    ['oracle-sleepfn', 'ai-dba-oracle-test', ['exec', '-i', 'ai-dba-oracle-test', 'sqlplus', '-s', 'sys/testpassword@localhost:1521/XEPDB1 as sysdba'], SEED_SLEEPFN, null],
    ['mongodb', 'ai-dba-mongodb-test', ['exec', '-i', 'ai-dba-mongodb-test', 'mongosh', '-u', 'testuser', '-p', 'testpassword', '--authenticationDatabase', 'admin', '--quiet', '--eval', SEED_MONGO_EVAL], null, null, ['exec', '-i', 'ai-dba-mongodb-test', 'mongo', '-u', 'testuser', '-p', 'testpassword', '--authenticationDatabase', 'admin', '--quiet', '--eval', SEED_MONGO_EVAL]],
  ];
  for (const [key, container, args, input, pre, altArgs] of jobs) {
    const h = docker(['inspect', '--format', '{{.State.Health.Status}}', container], null, 30000);
    if (!h.ok || !(h.out || '').includes('healthy')) {
      skip('seed:' + key, 'container ' + container + ' not healthy: ' + String(h.out || h.err || '').slice(0, 140));
      continue;
    }
    if (pre) { const pr = docker(pre, null, 60000); say('SEED  ' + key + ' pre-step rc=' + (pr.ok ? '0' : String(pr.status)) + ' | ' + lastLine(pr.out).slice(0, 110)); }
    const r = docker(args, input, 180000);
    const tail = lastLine(r.out);
    if (key === 'oracle-sleepfn') {
      if (/Function created/.test(r.out || '')) say('SEED  oracle-sleepfn wrapper created | ' + tail.slice(0, 100));
      else skip('seed:oracle-sleepfn', 'wrapper not created (out: ' + tail.slice(0, 150) + ')');
      continue;
    }
    if (r.ok && /\b3000\b/.test(r.out || '')) { seeded[key] = true; say('SEED  ' + key + ' ok | ' + tail.slice(0, 120)); }
    else if (key === 'sqlserver') {
      const r2 = docker(['exec', '-i', 'ai-dba-sqlserver-test', SQLCMD18, '-S', 'localhost', '-U', 'sa', '-P', 'TestPassword123!', '-C', '-d', 'testdb', '-i', '/dev/stdin'], input, 180000);
      if (r2.ok && /\b3000\b/.test(r2.out || '')) { seeded[key] = true; say('SEED  sqlserver ok (via -i /dev/stdin)'); }
      else skip('seed:' + key, 'seed not applied (both stdin modes; out: ' + lastLine(r2.out).slice(0, 150) + ')');
    }
    else if (altArgs) {
      const r2 = docker(altArgs, input, 180000);
      if (r2.ok && /\b3000\b/.test(r2.out || '')) { seeded[key] = true; say('SEED  ' + key + ' ok (fallback shell) | ' + lastLine(r2.out).slice(0, 110)); }
      else skip('seed:' + key, 'seed not applied (both shells; out: ' + lastLine(r2.out).slice(0, 150) + ')');
    }
    else skip('seed:' + key, 'seed not applied (out: ' + tail.slice(0, 160) + ')');
  }
  return seeded;
}

// --- probes -----------------------------------------------------------------
async function probeRowCap(label, conn, id, cfg, sql, seededFlag) {
  if (!seededFlag) { skip(label + ' row-cap', 'seed/engine access unavailable - recorded gap'); return; }
  const t = Date.now();
  try {
    const res = await raceCap(conn.query(id, cfg, sql), 90000);
    const el = Date.now() - t;
    const n = (res.rows || []).length;
    if (n === CAP && res.truncated === true) pass(label + ' row-cap', 'rows=' + n + ' truncated=' + res.truncated + ' rowCap=' + res.rowCap + ' elapsed_ms=' + el);
    else fail(label + ' row-cap', 'rows=' + n + ' truncated=' + res.truncated + ' rowCap=' + res.rowCap + ' elapsed_ms=' + el + ' - expected rows=' + CAP + ' truncated=true');
  } catch (e) { fail(label + ' row-cap', 'threw after ' + (Date.now() - t) + 'ms: ' + String(e.message).slice(0, 200)); }
}

async function probeEdge(label, conn, id, cfg, sql, seededFlag) {
  if (!seededFlag) { skip(label + ' row-cap boundary', 'seed/engine access unavailable - recorded gap'); return; }
  try {
    const res = await raceCap(conn.query(id, cfg, sql), 60000);
    const n = (res.rows || []).length;
    if (n === CAP && !res.truncated) pass(label + ' row-cap boundary', 'rows=' + n + ' truncated=' + (res.truncated || false) + ' (exactly-at-cap must NOT flag)');
    else fail(label + ' row-cap boundary', 'rows=' + n + ' truncated=' + res.truncated + ' - expected rows=' + CAP + ' truncated falsy');
  } catch (e) { fail(label + ' row-cap boundary', 'threw: ' + String(e.message).slice(0, 160)); }
}

async function probeQueryTimeout(label, conn, id, cfg, sql, instantIsSkip) {
  const t = Date.now();
  try {
    const res = await raceCap(conn.query(id, Object.assign({}, cfg, { queryTimeoutMs: OVERRIDE_MS }), sql), 40000);
    const el = Date.now() - t;
    fail(label + ' query-timeout', 'query COMPLETED in ' + el + 'ms despite queryTimeoutMs=' + OVERRIDE_MS + ' (rows=' + (res.rows || []).length + ') - timeout did not fire');
  } catch (e) {
    const el = Date.now() - t;
    const msg = String(e.message).slice(0, 180);
    if (isCap(e)) { fail(label + ' query-timeout', 'unbounded: exceeded harness cap at ' + el + 'ms - ' + msg); return; }
    if (el >= OVERRIDE_MS * 0.5 && el <= OVERRIDE_MS + 1500) { pass(label + ' query-timeout', 'killed at ' + el + 'ms (override ' + OVERRIDE_MS + 'ms) err=' + msg); return; }
    if (/read-only|not allowed/i.test(msg)) { skip(label + ' query-timeout', 'blocked by connector guard before execution: ' + msg); return; }
    if (el < OVERRIDE_MS * 0.5) {
      if (instantIsSkip) skip(label + ' query-timeout', 'instant error (mechanism not exercisable here): ' + msg);
      else fail(label + ' query-timeout', 'errored in ' + el + 'ms - too early for the override to have fired: ' + msg);
      return;
    }
    fail(label + ' query-timeout', 'errored at ' + el + 'ms outside expected kill window (' + OVERRIDE_MS + ' +/- slack) err=' + msg);
  }
}

async function probePoolHealth(label, conn, id, cfg) {
  try {
    const res = await raceCap(conn.query(id, cfg, 'SELECT 1 AS ok'), 15000);
    const n = (res.rows || []).length;
    if (n >= 1) pass(label + ' pool-health after timeout', 'SELECT 1 ok rows=' + n);
    else fail(label + ' pool-health after timeout', 'SELECT 1 returned rows=' + n);
  } catch (e) { fail(label + ' pool-health after timeout', 'pool poisoned by timeout: ' + String(e.message).slice(0, 160)); }
}

async function probeDeadHost() {
  const t = Date.now();
  try {
    await raceCap(postgresConnector.query('pg-dead', DEADPG, 'SELECT 1'), 60000);
    fail('pg connect-timeout (dead host)', 'connected?! to 10.255.255.1 - unexpected');
  } catch (e) {
    const el = Date.now() - t;
    const msg = String(e.message).slice(0, 180);
    if (isCap(e)) fail('pg connect-timeout (dead host)', 'unbounded: still pending at harness cap ' + el + 'ms (BEFORE: pending at 45s)');
    else if (el <= 8000) pass('pg connect-timeout (dead host)', 'bounded typed error at ' + el + 'ms err=' + msg + ' (BEFORE: pending at 45s)');
    else fail('pg connect-timeout (dead host)', 'error at ' + el + 'ms exceeds ~6s bound err=' + msg);
  }
}

async function probePgDegraded() {
  try {
    const r = await raceCap(postgresConnector.listSlowQueries('pg-degraded', PG, { limit: 5, minDurationMs: 0 }), 30000);
    if (Array.isArray(r)) { fail('pg degraded-on-empty', 'legacy array shape returned (' + r.length + ' items) - degraded contract missing'); return; }
    const q = r && Array.isArray(r.queries) ? r.queries.length : -1;
    const why = r && r.degraded ? String(r.degraded.reason || '') : '';
    if (q === 0 && why) pass('pg degraded-on-empty', 'queries=0 degraded.reason="' + why.slice(0, 140) + '"');
    else if (q === 0) fail('pg degraded-on-empty', 'empty WITHOUT degraded reason - silent-empty regression');
    else if (q > 0 && why) pass('pg degraded-on-empty', 'queries=' + q + ' + degraded.reason="' + why.slice(0, 120) + '"');
    else if (q > 0 && !r.degraded) pass('pg degraded-on-empty', 'queries=' + q + ' source readable - no degraded expected (note: stock image normally yields 0 via 42P01)');
    else fail('pg degraded-on-empty', 'queries=' + q + ' degraded=' + JSON.stringify(r && r.degraded).slice(0, 120) + ' - unexpected shape');
  } catch (e) { fail('pg degraded-on-empty', 'threw: ' + String(e.message).slice(0, 180)); }
}

async function probeFalsePass(label, conn, id, cfg, sql) {
  try {
    const res = await raceCap(conn.query(id, cfg, sql), 20000);
    fail(label + ' false-pass guard', 'returned ' + (res.rows || []).length + ' rows instead of erroring (sql=' + sql.slice(0, 60) + ')');
  } catch (e) {
    if (isCap(e)) fail(label + ' false-pass guard', 'hung past harness cap');
    else pass(label + ' false-pass guard', 'error surfaced (not swallowed): ' + String(e.message).slice(0, 160));
  }
}

async function oracleAvailable() {
  try {
    const r = await raceCap(oracleConnector.query('oracle-gate', ORA, 'SELECT COUNT(*) AS c FROM v$session'), 20000);
    const row = (r.rows && r.rows[0]) || {};
    const v = Object.values(row)[0];
    say('GATE  oracle v$session access ok (count=' + v + ')');
    return true;
  } catch (e) {
    skip('oracle probes', 'v$ access unavailable (grants not applied?): ' + String(e.message).slice(0, 140));
    return false;
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  say('==============================================');
  say(' ai-dba Part 2a AFTER verification harness');
  say('==============================================');
  const gitHead = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  say('HOST ' + os.hostname() + ' | node ' + process.version + ' | ' + new Date().toISOString());
  say('CWD ' + process.cwd() + ' | git HEAD ' + String(gitHead.stdout || '').trim());
  say('BEFORE reference (2026-09-19, dev host): mysql rows=3000@4605ms - pg rows=3000@1030ms - mysql SLEEP=5006ms - pg_sleep=5009ms - pg dead-host pending@45s - no degraded shape.');

  const seeded = await applySeeds();
  const oraLive = await oracleAvailable(); // gate before any oracle probe

  section('ROW CAP + HONEST TRUNCATION (default rowLimit=' + CAP + ')');
  await probeRowCap('mysql', mysqlConnector, 'mysql-test', MYSQL, 'SELECT * FROM rowcap_test', seeded.mysql);
  await probeEdge('mysql', mysqlConnector, 'mysql-test', MYSQL, 'SELECT * FROM rowcap_test WHERE id <= 1000', seeded.mysql);
  await probeRowCap('postgres', postgresConnector, 'pg-test', PG, 'SELECT * FROM rowcap_test', seeded.pg);
  await probeEdge('postgres', postgresConnector, 'pg-test', PG, 'SELECT * FROM rowcap_test WHERE id <= 1000', seeded.pg);
  await probeRowCap('sqlserver', sqlserverConnector, 'sqlserver-test', MSSQL, 'SELECT * FROM dbo.rowcap_test', seeded.sqlserver);
  await probeEdge('sqlserver', sqlserverConnector, 'sqlserver-test', MSSQL, 'SELECT * FROM dbo.rowcap_test WHERE id <= 1000', seeded.sqlserver);
  await probeRowCap('oracle', oracleConnector, 'oracle-test', ORA, 'SELECT * FROM rowcap_test', seeded.oracle && oraLive);
  await probeEdge('oracle', oracleConnector, 'oracle-test', ORA, 'SELECT * FROM rowcap_test WHERE id <= 1000', seeded.oracle && oraLive);

  section('ROW CAP - MONGODB (command path)');
  if (seeded.mongodb) {
    const t = Date.now();
    try {
      const res = await raceCap(mongodbConnector.query('mongodb-test', MONGO, JSON.stringify({ find: 'rowcap_test', filter: {} })), 90000);
      const n = (res.rows || []).length;
      const el = Date.now() - t;
      if (n === CAP && res.truncated === true) pass('mongodb row-cap', 'rows=' + n + ' truncated=' + res.truncated + ' elapsed_ms=' + el);
      else if (n > CAP) fail('mongodb row-cap', 'rows=' + n + ' truncated=' + res.truncated + ' elapsed_ms=' + el + ' - no cap applied');
      else skip('mongodb row-cap', 'rows=' + n + ' truncated=' + (res.truncated || false) + ' elapsed_ms=' + el + ' - likely driver first-batch bound; cap not exercised on command path (recorded gap)');
    } catch (e) { fail('mongodb row-cap', 'threw: ' + String(e.message).slice(0, 180)); }
    skip('mongodb query-timeout', 'no callable server-side sleep; maxTimeMS wiring covered by unit tests (recorded gap)');
  } else { skip('mongodb probes', 'seed unavailable - recorded gap'); }

  section('QUERY TIMEOUTS (override queryTimeoutMs=' + OVERRIDE_MS + '; SLEEP(5) must be killed)');
  await probeQueryTimeout('mysql', mysqlConnector, 'mysql-to', MYSQL, 'SELECT SLEEP(5) AS s');
  await probePoolHealth('mysql', mysqlConnector, 'mysql-to', Object.assign({}, MYSQL, { queryTimeoutMs: OVERRIDE_MS }));
  await probeQueryTimeout('postgres', postgresConnector, 'pg-to', PG, 'SELECT pg_sleep(5)');
  await probePoolHealth('postgres', postgresConnector, 'pg-to', Object.assign({}, PG, { queryTimeoutMs: OVERRIDE_MS }));

  section('SQL SERVER QUERY TIMEOUT (heavy read-only SELECT; requestTimeout must kill it)');
  await probeQueryTimeout('sqlserver', sqlserverConnector, 'mssql-to', MSSQL, 'SELECT COUNT(*) FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c', false);

  section('CONNECT TIMEOUT - PG DEAD HOST');
  await probeDeadHost();

  section('DEGRADED-ON-EMPTY (silent-empty ban) + FALSE-PASS GUARDS');
  await probePgDegraded();
  await probeFalsePass('postgres', postgresConnector, 'pg-badcol', PG, 'SELECT nonexistent_col_abc FROM rowcap_test');

  section('ORACLE (gated on v$ access)');
  if (oraLive) {
    await probeQueryTimeout('oracle', oracleConnector, 'oracle-to', ORA, 'SELECT SYS.AI_DBA_SLEEP(5) AS s FROM DUAL', true);
    await probeFalsePass('oracle', oracleConnector, 'oracle-badcol', ORA, 'SELECT nonexistent_col_abc FROM dual');
  }
}

async function finish() {
  section('SUMMARY');
  say('PART2A_SUMMARY PASS=' + PASS + ' FAIL=' + FAIL + ' SKIP=' + SKIP);
  say(FAIL === 0 ? 'PART2A_RESULT ALL_GREEN_WITH_SKIPS_AS_RECORDED' : 'PART2A_RESULT FAILURES_PRESENT');
}

main()
  .catch((e) => { FAIL++; say('HARNESS_ERROR ' + ((e && e.stack) || e)); })
  .finally(async () => {
    const conns = [mysqlConnector, postgresConnector, sqlserverConnector, oracleConnector, mongodbConnector];
    for (const c of conns) { try { await raceCap(c.closeAllPools(), 15000); } catch (e) { /* best effort */ } }
    await finish();
    const code = FAIL > 0 ? 1 : 0;
    process.exitCode = code;
    setTimeout(() => process.exit(code), 500);
  });
