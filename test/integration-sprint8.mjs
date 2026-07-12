// Integration test — Sprint 8 features (table-sizes, explain, slow-queries, health-check)
// Requires: docker compose up -d (all 5 engines running)
import { mysqlConnector } from '../dist/connectors/mysql.js';
import { postgresConnector } from '../dist/connectors/postgres.js';
import { sqlserverConnector } from '../dist/connectors/sqlserver.js';
import { oracleConnector } from '../dist/connectors/oracle.js';
import { mongodbConnector } from '../dist/connectors/mongodb.js';

const engines = {
  'mysql-test': { type: 'mysql', host: '127.0.0.1', port: 13306, user: 'root', password: 'testpassword', database: 'testdb' },
  'pg-test': { type: 'postgres', url: 'postgresql://postgres@127.0.0.1:15432/testdb' },
  'sqlserver-test': { type: 'sqlserver', url: 'sqlserver://sa:TestPassword123!@127.0.0.1:11433/testdb' },
  'oracle-test': { type: 'oracle', url: 'oracle://testuser:testpassword@127.0.0.1:11521/XEPDB1' },
  'mongodb-test': { type: 'mongodb', url: 'mongodb://testuser:testpassword@127.0.0.1:12017/testdb?authSource=admin' },
};

const connectors = { mysql: mysqlConnector, postgres: postgresConnector, sqlserver: sqlserverConnector, oracle: oracleConnector, mongodb: mongodbConnector };

let passed = 0, failed = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}  ${detail}`); }
}

async function testTableSizes(engineId, engineConfig, connector) {
  const label = `[${engineId}] table-sizes`;
  try {
    const sizes = await connector.listTableSizes(engineId, engineConfig);
    assert(`${label} returns array`, Array.isArray(sizes), `got: ${typeof sizes}`);
    assert(`${label} has results`, sizes.length > 0, `empty result`);

    // Find blocking_test table (case varies by engine)
    const target = sizes.find(s =>
      s.name === 'blocking_test' || s.name === 'BLOCKING_TEST'
    );
    assert(`${label} has blocking_test`, !!target, `got: ${sizes.map(s => s.name).join(',')}`);

    if (target) {
      assert(`${label} has totalSizeBytes`, typeof target.totalSizeBytes === 'number' && target.totalSizeBytes >= 0, `got: ${target.totalSizeBytes}`);
      assert(`${label} has name field`, typeof target.name === 'string');
    }
  } catch (e) { assert(`${label}`, false, e.message); }
}

async function testExplain(engineId, engineConfig, connector) {
  const label = `[${engineId}] explain`;
  const isMongo = engineConfig.type === 'mongodb';
  const isOracle = engineConfig.type === 'oracle';

  try {
    let query;
    if (isMongo) {
      query = JSON.stringify({ find: 'blocking_test', filter: {} });
    } else if (isOracle) {
      query = 'SELECT * FROM blocking_test WHERE ROWNUM <= 1';
    } else if (engineConfig.type === 'sqlserver') {
      query = 'SELECT TOP 1 * FROM blocking_test';
    } else {
      query = 'SELECT * FROM blocking_test LIMIT 1';
    }

    const result = await connector.explainQuery(engineId, engineConfig, query, { analyze: false });
    assert(`${label} returns result`, !!result);
    assert(`${label} has plan`, typeof result.plan === 'string' && result.plan.length > 0, `got: ${typeof result.plan}`);
    assert(`${label} has format`, ['json', 'text', 'xml'].includes(result.format), `got: ${result.format}`);
    assert(`${label} analyzed is false`, result.analyzed === false, `got: ${result.analyzed}`);
  } catch (e) { assert(`${label}`, false, e.message); }
}

async function testSlowQueries(engineId, engineConfig, connector) {
  const label = `[${engineId}] slow-queries`;
  try {
    const queries = await connector.listSlowQueries(engineId, engineConfig, { limit: 5, minDurationMs: 0 });
    assert(`${label} returns array`, Array.isArray(queries), `got: ${typeof queries}`);

    // MySQL and SQL Server should have data; PG/Oracle/Mongo may be empty (graceful degradation)
    if (queries.length > 0) {
      const q = queries[0];
      assert(`${label} has id`, typeof q.id === 'string', `got: ${typeof q.id}`);
      assert(`${label} has query`, typeof q.query === 'string', `got: ${typeof q.query}`);
      assert(`${label} has totalExecutionTimeMs`, typeof q.totalExecutionTimeMs === 'number', `got: ${typeof q.totalExecutionTimeMs}`);
    } else {
      assert(`${label} empty (graceful degradation)`, true);
    }
  } catch (e) { assert(`${label}`, false, e.message); }
}

async function testHealthCheck(engineId, engineConfig, connector) {
  const label = `[${engineId}] health-check`;
  try {
    // 1. Connectivity
    let connected = false;
    try {
      const probeSql =
        engineConfig.type === 'oracle' ? 'SELECT 1 FROM DUAL' :
        engineConfig.type === 'mongodb' ? JSON.stringify({ ping: 1 }) :
        'SELECT 1';
      await connector.query(engineId, engineConfig, probeSql);
      connected = true;
    } catch (e) { /* will be caught below */ }

    assert(`${label} connectivity pass`, connected);

    // 2. Blocking chains
    try {
      const chains = await connector.getBlockingChains(engineId, engineConfig);
      assert(`${label} blocking returns array`, Array.isArray(chains));
      assert(`${label} no active blocks`, chains.length === 0, `got ${chains.length} chains`);
    } catch (e) { assert(`${label} blocking check`, false, e.message); }

    // 3. Processes
    try {
      const procs = await connector.listProcesses(engineId, engineConfig);
      assert(`${label} processes returns array`, Array.isArray(procs));
    } catch (e) { assert(`${label} processes check`, false, e.message); }

    // 4. Slow queries
    try {
      const sq = await connector.listSlowQueries(engineId, engineConfig, { limit: 5, minDurationMs: 1000 });
      assert(`${label} slow-queries returns array`, Array.isArray(sq));
    } catch (e) { assert(`${label} slow-queries check`, false, e.message); }
  } catch (e) { assert(`${label}`, false, e.message); }
}

async function main() {
  console.log('========================================');
  console.log(' AI-DBA Integration — Sprint 8 Features');
  console.log('========================================');

  for (const [engineId, engineConfig] of Object.entries(engines)) {
    const connector = connectors[engineConfig.type];
    console.log(`\n=== [${engineId}] ===`);
    await testTableSizes(engineId, engineConfig, connector);
    await testExplain(engineId, engineConfig, connector);
    await testSlowQueries(engineId, engineConfig, connector);
    await testHealthCheck(engineId, engineConfig, connector);
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