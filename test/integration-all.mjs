// Integration test — exercises all connector methods against live Docker databases
// Requires: docker compose up -d (MySQL 13306, PostgreSQL 15432, SQL Server 11433, Oracle 11521)
import { mysqlConnector } from '../dist/connectors/mysql.js';
import { postgresConnector } from '../dist/connectors/postgres.js';
import { sqlserverConnector } from '../dist/connectors/sqlserver.js';
import { oracleConnector } from '../dist/connectors/oracle.js';

const engines = {
  'mysql-test': { type: 'mysql', host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' },
  'pg-test': { type: 'postgres', url: 'postgresql://postgres@127.0.0.1:15432/testdb' },
  'sqlserver-test': { type: 'sqlserver', url: 'sqlserver://sa:TestPassword123!@127.0.0.1:11433/testdb' },
  'oracle-test': { type: 'oracle', url: 'oracle://testuser:testpassword@127.0.0.1:11521/XEPDB1' },
};

const connectors = { mysql: mysqlConnector, postgres: postgresConnector, sqlserver: sqlserverConnector, oracle: oracleConnector };

let passed = 0, failed = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}  ${detail}`); }
}

async function testEngine(engineId, engineConfig, connector) {
  const label = `[${engineId}]`;
  console.log(`\n=== ${label} ===`);

  // 1. listDatabases
  try {
    const dbs = await connector.listDatabases(engineId, engineConfig);
    assert(`${label} listDatabases returns array`, Array.isArray(dbs));
    if (engineConfig.type === 'oracle') {
      // Oracle returns schema/user names, not database names
      assert(`${label} listDatabases has TESTUSER`, dbs.some(d => d.name === 'TESTUSER'), `got: ${dbs.map(d=>d.name).join(',')}`);
    } else {
      assert(`${label} listDatabases has testdb`, dbs.some(d => d.name === 'testdb'), `got: ${dbs.map(d=>d.name).join(',')}`);
    }
    assert(`${label} listDatabases has name field`, dbs.length > 0 && typeof dbs[0].name === 'string');
  } catch (e) { assert(`${label} listDatabases`, false, e.message); }

  // 2. listTables
  try {
    const tables = await connector.listTables(engineId, engineConfig);
    assert(`${label} listTables returns array`, Array.isArray(tables));
    if (engineConfig.type === 'oracle') {
      // Oracle stores identifiers in uppercase
      assert(`${label} listTables has BLOCKING_TEST`, tables.some(t => t.name === 'BLOCKING_TEST'), `got: ${tables.map(t=>t.name).join(',')}`);
    } else {
      assert(`${label} listTables has blocking_test`, tables.some(t => t.name === 'blocking_test'), `got: ${tables.map(t=>t.name).join(',')}`);
    }
    assert(`${label} listTables has name field`, tables.length > 0 && typeof tables[0].name === 'string');
  } catch (e) { assert(`${label} listTables`, false, e.message); }

  // 3. listTables with database/schema override
  try {
    if (engineConfig.type === 'mysql') {
      const tables = await connector.listTables(engineId, engineConfig, 'information_schema');
      assert(`${label} listTables(information_schema) has TABLES`, tables.some(t => t.name === 'TABLES'), `got: ${tables.map(t=>t.name).join(',')}`);
    } else if (engineConfig.type === 'postgres') {
      const tables = await connector.listTables(engineId, engineConfig, 'public');
      assert(`${label} listTables(public) has blocking_test`, tables.some(t => t.name === 'blocking_test'), `got: ${tables.map(t=>t.name).join(',')}`);
    } else if (engineConfig.type === 'sqlserver') {
      const tables = await connector.listTables(engineId, engineConfig, 'dbo');
      assert(`${label} listTables(dbo) has blocking_test`, tables.some(t => t.name === 'blocking_test'), `got: ${tables.map(t=>t.name).join(',')}`);
    } else if (engineConfig.type === 'oracle') {
      const tables = await connector.listTables(engineId, engineConfig, 'TESTUSER');
      assert(`${label} listTables(TESTUSER) has BLOCKING_TEST`, tables.some(t => t.name === 'BLOCKING_TEST'), `got: ${tables.map(t=>t.name).join(',')}`);
    }
  } catch (e) { assert(`${label} listTables(database override)`, false, e.message); }

  // 4. describeTable
  try {
    const cols = await connector.describeTable(engineId, engineConfig, 'blocking_test');
    assert(`${label} describeTable returns array`, Array.isArray(cols));
    assert(`${label} describeTable has id column`, cols.some(c => c.name === 'ID' || c.name === 'id'), `got: ${cols.map(c=>c.name).join(',')}`);
    const idCol = cols.find(c => c.name === 'ID' || c.name === 'id');
    assert(`${label} describeTable id is primary key`, idCol?.isPrimary === true);
    assert(`${label} describeTable id is auto-increment`, idCol?.isAutoIncrement === true);
    if (engineConfig.type === 'mysql') {
      const nameCol = cols.find(c => c.name === 'name');
      assert(`${label} describeTable name is varchar`, nameCol?.type.includes('varchar'), `got: ${nameCol?.type}`);
    } else if (engineConfig.type === 'oracle') {
      const nameCol = cols.find(c => c.name === 'NAME');
      assert(`${label} describeTable name is VARCHAR2`, nameCol?.type.includes('VARCHAR2'), `got: ${nameCol?.type}`);
    }
  } catch (e) { assert(`${label} describeTable`, false, e.message); }

  // 5. listIndexes
  try {
    const idxs = await connector.listIndexes(engineId, engineConfig, 'blocking_test');
    assert(`${label} listIndexes returns array`, Array.isArray(idxs));
    if (engineConfig.type === 'oracle') {
      // Oracle PK index names start with SYS_C*
      assert(`${label} listIndexes has primary`, idxs.some(i => i.isPrimary === true), `got: ${idxs.map(i=>i.name).join(',')}`);
    } else {
      assert(`${label} listIndexes has PRIMARY or _pkey`, idxs.some(i => i.isPrimary === true), `got: ${idxs.map(i=>i.name).join(',')}`);
    }
    const pk = idxs.find(i => i.isPrimary);
    assert(`${label} listIndexes PK has id column`, pk?.columns.includes('ID') || pk?.columns.includes('id'), `got: ${pk?.columns}`);
    assert(`${label} listIndexes PK is unique`, pk?.isUnique === true);
  } catch (e) { assert(`${label} listIndexes`, false, e.message); }

  // 6. listProcesses
  try {
    const procs = await connector.listProcesses(engineId, engineConfig);
    assert(`${label} listProcesses returns array`, Array.isArray(procs));
    if (procs.length > 0) {
      assert(`${label} listProcesses has pid field`, typeof procs[0].pid === 'number');
      assert(`${label} listProcesses has user field`, typeof procs[0].user === 'string');
    } else {
      assert(`${label} listProcesses returns array (empty ok)`, true);
    }
  } catch (e) { assert(`${label} listProcesses`, false, e.message); }

  // 7. query (read-only)
  try {
    // Oracle requires FROM DUAL for bare SELECT
    const querySql = engineConfig.type === 'oracle'
      ? 'SELECT 1 AS val FROM DUAL'
      : 'SELECT 1 as val';
    const result = await connector.query(engineId, engineConfig, querySql);
    // Oracle uppercases column names by default
    const valCol = result.columns.find(c => c === 'VAL' || c === 'val');
    assert(`${label} query SELECT 1 returns columns`, !!valCol, `got: ${result.columns.join(',')}`);
    assert(`${label} query SELECT 1 returns rows`, result.rows.length === 1);
    const row = result.rows[0];
    const val = row.VAL ?? row.val;
    assert(`${label} query SELECT 1 value is 1`, Number(val) === 1, `got: ${val}`);
  } catch (e) { assert(`${label} query`, false, e.message); }

  // 8. query rejects non-read-only
  try {
    await connector.query(engineId, engineConfig, 'DROP TABLE nonexistent_xyz');
    assert(`${label} query rejects DROP`, false, 'should have thrown');
  } catch (e) {
    assert(`${label} query rejects DROP`, e.message.includes('read-only'));
  }

  // 9. getBlockingChains (no active blocks expected)
  try {
    const chains = await connector.getBlockingChains(engineId, engineConfig);
    assert(`${label} getBlockingChains returns array`, Array.isArray(chains));
    assert(`${label} getBlockingChains empty (no blocks)`, chains.length === 0);
  } catch (e) { assert(`${label} getBlockingChains`, false, e.message); }
}

async function main() {
  console.log('========================================');
  console.log(' AI-DBA Integration Tests — Live Databases');
  console.log('========================================');

  for (const [engineId, engineConfig] of Object.entries(engines)) {
    const connector = connectors[engineConfig.type];
    await testEngine(engineId, engineConfig, connector);
  }

  // Print results
  console.log('\n========================================');
  console.log(' RESULTS');
  console.log('========================================');
  for (const r of results) console.log(r);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  // Cleanup
  for (const connector of Object.values(connectors)) {
    await connector.closeAllPools();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });