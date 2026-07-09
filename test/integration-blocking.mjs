// Integration test — validates blocking chains detection against live Docker databases
// Uses direct connector calls (not CLI subprocess) to avoid execSync deadlock
// Requires: docker compose up -d (MySQL 13306, PostgreSQL 15432)
import mysql from 'mysql2/promise';
import pg from 'pg';
import { mysqlConnector } from '../dist/connectors/mysql.js';
import { postgresConnector } from '../dist/connectors/postgres.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const mysqlConfig = { type: 'mysql', host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' };
const pgConfig = { type: 'postgres', url: 'postgresql://postgres@127.0.0.1:15432/testdb' };

async function testMysqlBlocking() {
  console.log('\n=== MySQL Blocking Scenario ===');
  // Use raw connections for the blocker/blocked sessions (separate from connector pool)
  const conn1 = await mysql.createConnection({ host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' });
  const conn2 = await mysql.createConnection({ host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' });

  try {
    // Session 1: BEGIN + UPDATE (hold lock, don't commit)
    await conn1.query('BEGIN');
    await conn1.query("UPDATE blocking_test SET value = 999 WHERE id = 1");
    console.log('  Session 1: BEGIN + UPDATE (lock held)');

    // Session 2: UPDATE same row (will block — set short timeout so it doesn't hang forever)
    await conn2.query('SET SESSION innodb_lock_wait_timeout = 10');
    const blockedPromise = conn2.query("UPDATE blocking_test SET value = 888 WHERE id = 1").catch(() => {});
    await sleep(2000);
    console.log('  Session 2: UPDATE (blocked, waiting)');

    // Call connector directly — no subprocess, no execSync deadlock
    const chains = await mysqlConnector.getBlockingChains('mysql-test', mysqlConfig);

    assert('MySQL blocking-chains detects 1 chain', chains.length === 1, `got ${chains.length}`);
    if (chains.length > 0) {
      const c = chains[0];
      assert('MySQL has blocked_pid', typeof c.blocked_pid === 'number');
      assert('MySQL has blocking_pid', typeof c.blocking_pid === 'number');
      assert('MySQL blocked != blocking PID', c.blocked_pid !== c.blocking_pid, `both: ${c.blocked_pid}`);
      assert('MySQL has wait_duration_ms', c.wait_duration_ms != null && c.wait_duration_ms > 0, `got ${c.wait_duration_ms}`);
      assert('MySQL has blocked_query', c.blocked_query?.includes('UPDATE') ?? false, `got: ${c.blocked_query}`);
      assert('MySQL has blocking_query', c.blocking_query?.includes('UPDATE') ?? false, `got: ${c.blocking_query}`);
      assert('MySQL has database_name', c.database_name === 'testdb', `got: ${c.database_name}`);
      assert('MySQL has engine_id', c.engine_id === 'mysql-test');
    }

    // Cleanup: release the block
    await conn1.query('ROLLBACK');
    await sleep(1000);
    await blockedPromise;
    console.log('  Block released (ROLLBACK)');

    // Verify no chains after release
    const chains2 = await mysqlConnector.getBlockingChains('mysql-test', mysqlConfig);
    assert('MySQL no chains after release', chains2.length === 0);
  } finally {
    await conn1.end().catch(() => {});
    await conn2.end().catch(() => {});
  }
}

async function testPostgresBlocking() {
  console.log('\n=== PostgreSQL Blocking Scenario ===');
  const conn1 = new pg.Client({ host: '127.0.0.1', port: 15432, user: 'postgres', password: 'testpassword', database: 'testdb' });
  const conn2 = new pg.Client({ host: '127.0.0.1', port: 15432, user: 'postgres', password: 'testpassword', database: 'testdb' });

  await conn1.connect();
  await conn2.connect();

  try {
    // Session 1: BEGIN + LOCK TABLE
    await conn1.query('BEGIN');
    await conn1.query('LOCK TABLE blocking_test IN ACCESS EXCLUSIVE MODE');
    console.log('  Session 1: BEGIN + LOCK TABLE (lock held)');

    // Session 2: SELECT (will block)
    const blockedPromise = conn2.query('SELECT * FROM blocking_test LIMIT 1').catch(() => {});
    await sleep(2000);
    console.log('  Session 2: SELECT (blocked, waiting)');

    // Call connector directly
    const chains = await postgresConnector.getBlockingChains('pg-test', pgConfig);

    assert('PG blocking-chains detects 1 chain', chains.length === 1, `got ${chains.length}`);
    if (chains.length > 0) {
      const c = chains[0];
      assert('PG has blocked_pid', typeof c.blocked_pid === 'number');
      assert('PG has blocking_pid', typeof c.blocking_pid === 'number');
      assert('PG blocked != blocking PID', c.blocked_pid !== c.blocking_pid, `both: ${c.blocked_pid}`);
      assert('PG has wait_duration_ms', c.wait_duration_ms != null && c.wait_duration_ms > 0, `got ${c.wait_duration_ms}`);
      assert('PG has blocked_query', c.blocked_query?.includes('SELECT') ?? false, `got: ${c.blocked_query}`);
      assert('PG has blocking_query', c.blocking_query?.includes('LOCK TABLE') ?? false, `got: ${c.blocking_query}`);
      assert('PG has database_name', c.database_name === 'testdb', `got: ${c.database_name}`);
      assert('PG has engine_id', c.engine_id === 'pg-test');
      assert('PG has wait_event', c.wait_event != null, `got: ${c.wait_event}`);
    }

    // Cleanup
    await conn1.query('ROLLBACK');
    await sleep(1000);
    await blockedPromise;
    console.log('  Block released (ROLLBACK)');

    // Verify no chains after release
    const chains2 = await postgresConnector.getBlockingChains('pg-test', pgConfig);
    assert('PG no chains after release', chains2.length === 0);
  } finally {
    await conn1.end().catch(() => {});
    await conn2.end().catch(() => {});
  }
}

async function main() {
  console.log('========================================');
  console.log(' AI-DBA Integration — Live Blocking Tests');
  console.log('========================================');

  await testMysqlBlocking();
  await testPostgresBlocking();

  // Cleanup connector pools
  await mysqlConnector.closeAllPools();
  await postgresConnector.closeAllPools();

  console.log('\n========================================');
  console.log(` ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });