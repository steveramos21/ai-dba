// Creates a real PostgreSQL blocking scenario using the pg driver
import pg from 'pg';

const config = {
  host: '127.0.0.1',
  port: 15432,
  user: 'postgres',
  password: 'testpassword',
  database: 'testdb',
};

async function main() {
  // Session 1: start transaction and hold an ACCESS EXCLUSIVE lock
  const client1 = new pg.Client(config);
  await client1.connect();
  await client1.query('BEGIN');
  await client1.query('LOCK TABLE blocking_test IN ACCESS EXCLUSIVE MODE');
  console.log('Session 1: ACCESS EXCLUSIVE lock held on blocking_test');

  // Session 2: try to read from the locked table (will block)
  const client2 = new pg.Client(config);
  await client2.connect();
  // Don't await this — it will block
  const selectPromise = client2.query('SELECT * FROM blocking_test LIMIT 1');

  // Give it a moment to start waiting
  await new Promise(r => setTimeout(r, 1000));

  console.log('Session 2: Waiting on ACCESS EXCLUSIVE lock');
  console.log('Blocking scenario is active. Running ai-dba blocking-chains...');

  // Now run the CLI
  const { execSync } = await import('child_process');
  const result = execSync('node dist/index.js --config config.yaml blocking-chains postgres-test', {
    cwd: '/mnt/d/ai-dba',
    encoding: 'utf-8',
  });
  console.log(result);

  // Also test JSON output
  console.log('\n--- JSON output ---');
  const resultJson = execSync('node dist/index.js --config config.yaml blocking-chains postgres-test --json', {
    cwd: '/mnt/d/ai-dba',
    encoding: 'utf-8',
  });
  console.log(resultJson);

  // Clean up
  await client1.query('ROLLBACK');
  await client1.end();
  // client2 should complete now
  await selectPromise;
  await client2.end();
  console.log('Cleaned up blocking sessions');
}

main().catch(e => { console.error(e); process.exit(1); });