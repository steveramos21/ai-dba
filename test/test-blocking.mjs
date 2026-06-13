// Creates a real MySQL blocking scenario using the Node.js mysql2 driver
import mysql from 'mysql2/promise';

const config = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: 'testpassword',
  database: 'testdb',
};

async function main() {
  // Session 1: start transaction and hold a lock
  const conn1 = await mysql.createConnection(config);
  await conn1.query('START TRANSACTION');
  await conn1.query('UPDATE blocking_test SET value = 999 WHERE id = 1');
  console.log('Session 1: Lock held on row id=1');

  // Session 2: try to update the same row (will block)
  const conn2 = await mysql.createConnection(config);
  // Don't await this — it will block
  const updatePromise = conn2.query('UPDATE blocking_test SET value = 888 WHERE id = 1');
  
  // Give it a moment to start waiting
  await new Promise(r => setTimeout(r, 1000));
  
  console.log('Session 2: Waiting on lock');
  console.log('Blocking scenario is active. Running ai-dba blocking-chains...');
  
  // Now run the CLI
  const { execSync } = await import('child_process');
  const result = execSync('node dist/index.js --config config.yaml blocking-chains mysql-test', {
    cwd: '/mnt/d/ai-dba',
    encoding: 'utf-8',
  });
  console.log(result);
  
  // Also test JSON output
  console.log('\n--- JSON output ---');
  const resultJson = execSync('node dist/index.js --config config.yaml blocking-chains mysql-test --json', {
    cwd: '/mnt/d/ai-dba',
    encoding: 'utf-8',
  });
  console.log(resultJson);
  
  // Clean up
  await conn1.query('ROLLBACK');
  await conn1.end();
  // conn2 should complete now
  await updatePromise;
  await conn2.end();
  console.log('Cleaned up blocking sessions');
}

main().catch(e => { console.error(e); process.exit(1); });