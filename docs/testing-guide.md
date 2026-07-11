# AI-DBA Manual Testing Guide

This guide covers manual testing procedures for all sprints. Each section reflects the actual merged state of the codebase.

## Quick Reference

| Sprint | Scope | Status | Test Doc |
|--------|-------|--------|----------|
| 1 | Blocking chains (MySQL) | MERGED | [Sprints 1-3 Tests](#sprints-1-3-merged) |
| 2 | PostgreSQL connector | MERGED | [Sprints 1-3 Tests](#sprints-1-3-merged) |
| 3 | MCP DBA tools + CI | MERGED | [Sprints 1-3 Tests](#sprints-1-3-merged) |
| 4 | SQL Server connector | MERGED | [Sprint 4 - SQL Server](#sprint-4-sql-server) |
| 5 | Oracle connector | MERGED | [Sprint 5 - Oracle](#sprint-5-oracle) |
| 6 | MongoDB connector | MERGED | [Sprint 6 - MongoDB](#sprint-6-mongodb) |
| 8 | Query performance & health | COMPLETE | [Sprint 8 - Performance](#sprint-8-query-performance-health) |

**Test totals:** 75 unit tests + 121 integration tests + 84 Sprint 8 integration tests = 280 tests, all passing.

## Prerequisites (all sprints)

```bash
cd /mnt/d/ai-dba
npm install
npm run build
```

Docker must be running. Verify:
```bash
docker info | head -3
```

---

## Sprints 1-3 (MERGED)

### 1. Unit Tests (no Docker needed)

```bash
npm test
```

**Expected:** 15 test files, 75 tests, all passing. Duration ~20s.

### 2. Integration Tests (Docker required)

Start containers:
```bash
docker compose up -d
# Wait for all containers to be healthy
docker inspect --format='{{.State.Health.Status}}' ai-dba-mysql-test
docker inspect --format='{{.State.Health.Status}}' ai-dba-postgres-test
# Both must show "healthy"
```

Seed test data:
```bash
# MySQL
docker exec ai-dba-mysql-test mysql -uroot -ptestpassword testdb \
  -e "CREATE TABLE IF NOT EXISTS blocking_test (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT); INSERT IGNORE INTO blocking_test (name, value) VALUES ('alpha',1),('beta',2),('gamma',3);"

# PostgreSQL
docker exec ai-dba-postgres-test psql -U postgres -d testdb \
  -c "CREATE TABLE IF NOT EXISTS blocking_test (id SERIAL PRIMARY KEY, value INT); INSERT INTO blocking_test (value) VALUES (1) ON CONFLICT DO NOTHING;"
```

Run integration tests:
```bash
node test/integration-all.mjs
```
**Expected:** 121 tests, 0 failures. Tests all connector methods (listDatabases, listTables, describeTable, listIndexes, listProcesses, query, getBlockingChains) against all 5 live databases.

### 3. CLI Smoke Tests

```bash
# Version
node dist/index.js --version
# Expected: 1.0.0

# List engines (uses config.yaml.example)
node dist/index.js --config config.yaml.example list-engines
# Expected: Table with all 5 engines, URLs properly masked

# Blocking chains (no active blocks)
node dist/index.js --config config.yaml blocking-chains mysql-test
# Expected: "No blocking chains found on mysql-test"
```

### 4. REPL Smoke Test

```bash
node dist/index.js --config config.yaml repl
```

Type these commands and verify output:
```
help              — shows command list
engines           — table with all engines, * on current
use postgres-test  — "Switched to postgres-test"
databases         — table with testdb, postgres, etc.
tables            — table with blocking_test
describe blocking_test — columns: id (PRI, auto_increment), value
indexes blocking_test  — PRIMARY index on id
processes         — list of active connections
blocking-chains   — "No blocking chains."
quit              — "Bye."
```

### 5. MCP Server Smoke Test

```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | timeout 5 node dist/index.js --config config.yaml serve 2>/dev/null
```
**Expected:** JSON response listing 10 tools: blocking-chains, databases, tables, describe-table, indexes, processes, table-sizes, explain, slow-queries, health-check.

---

## Sprint 4 - SQL Server

**Status:** MERGED (PR #11)
**Driver:** `tedious` (raw driver, promise-based wrapper)
**Docker image:** `mcr.microsoft.com/mssql/server:2022-latest`
**Port:** 11433 (host) → 1433 (container)

### Prerequisites

- Docker with 2+ GB RAM available for SQL Server container
- `npm install` includes `tedious` (already in package.json)

### Docker Setup (in docker-compose.yml)

```yaml
  sqlserver-test:
    image: mcr.microsoft.com/mssql/server:2022-latest
    container_name: ai-dba-sqlserver-test
    restart: unless-stopped
    ports:
      - "11433:1433"
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "TestPassword123!"
      MSSQL_PID: "Express"
    healthcheck:
      test: ["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -C -Q 'SELECT 1' || /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -Q 'SELECT 1'"]
      interval: 10s
      timeout: 5s
      retries: 10
```

### Config (in config.yaml.example)

```yaml
  sqlserver-test:
    type: sqlserver
    url: sqlserver://sa:TestPassword123!@127.0.0.1:11433/testdb
```

### Manual Test Procedure

**Step 1: Start container**
```bash
docker compose up -d sqlserver-test
docker inspect --format='{{.State.Health.Status}}' ai-dba-sqlserver-test
# Wait for "healthy" — SQL Server takes 20-30s to initialize
```

**Step 2: Create test database and table**
```bash
docker exec ai-dba-sqlserver-test /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -C \
  -Q "IF DB_ID('testdb') IS NULL CREATE DATABASE testdb"

docker exec ai-dba-sqlserver-test /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -C -d testdb \
  -Q "IF OBJECT_ID('blocking_test','U') IS NULL CREATE TABLE blocking_test (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100), value INT); IF NOT EXISTS (SELECT 1 FROM blocking_test) INSERT INTO blocking_test (name, value) VALUES ('alpha',1),('beta',2),('gamma',3);"
```

**Step 3: Run unit tests**
```bash
npm test
# Expected: 15 test files, 75 tests (includes 4 SQL Server URL parser tests)
```

**Step 4: Run integration tests**
```bash
node test/integration-all.mjs
# Expected: 121 tests total, 0 failures (includes 24 SQL Server tests). Sprint 8 adds 84 more via `npm run test:integration:sprint8`.
```

**Step 5: CLI tests**
```bash
node dist/index.js --config config.yaml list-engines
# Expected: 5 engines including sqlserver-test

node dist/index.js --config config.yaml blocking-chains sqlserver-test
# Expected: "No blocking chains found on sqlserver-test"
```

**Step 6: REPL tests**
```bash
node dist/index.js --config config.yaml repl
# Type:
use sqlserver-test
databases         — should list testdb, master, tempdb, model, msdb
tables            — should list blocking_test
describe blocking_test — columns: id (int, PRI, IDENTITY), name (nvarchar), value (int)
indexes blocking_test  — PRIMARY key index on id (CLUSTERED, UNIQUE)
processes         — active user connections (system processes filtered out)
blocking-chains   — no chains
sql SELECT @@VERSION — should return SQL Server 2022 version string
```

**Step 7: Blocking scenario test**

Open two SQL Server sessions:
```bash
# Session 1 — hold lock
docker exec -i ai-dba-sqlserver-test /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -C -d testdb \
  -Q "BEGIN TRAN; UPDATE blocking_test SET value=999 WHERE id=1; WAITFOR DELAY '00:00:15'; ROLLBACK TRAN;"

# Session 2 (in another terminal, immediately) — blocked
docker exec -i ai-dba-sqlserver-test /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -C -d testdb \
  -Q "UPDATE blocking_test SET value=888 WHERE id=1;"
```

While both sessions are active, run:
```bash
node dist/index.js --config config.yaml blocking-chains sqlserver-test --json
```

**Expected JSON:**
```json
{
  "chains": [{
    "engine_id": "sqlserver-test",
    "blocking_pid": <number>,
    "blocked_pid": <number>,
    "wait_duration_ms": <positive number>,
    "wait_event": "LCK_M_X",
    "blocking_query": "UPDATE blocking_test SET value=999 WHERE id=1",
    "blocked_query": "UPDATE blocking_test SET value=888 WHERE id=1",
    "database_name": "testdb",
    "wait_type": "LCK",
    "status": "suspended",
    "host_name": "<hostname>",
    "program_name": "sqlcmd",
    "login_time": null
  }],
  "count": 1
}
```

**Step 8: MCP tool test**
```bash
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"databases","arguments":{"engineId":"sqlserver-test"}},"id":2}' | timeout 5 node dist/index.js --config config.yaml serve 2>/dev/null
```
**Expected:** JSON with databases array containing testdb, master, tempdb, model, msdb.

### Known Issues

- **No connection pooling:** Each connector method creates a new TCP connection. This is a known limitation — the `TediousConnection` wrapper opens/closes per call.
- **tedious type definitions:** The `.d.ts` for tedious doesn't expose `columnMetadata`/`row` as typed events. The connector casts through `any` to subscribe.
- **System processes filtered:** `listProcesses` filters to `session_id >= 50 AND is_user_process = 1` to exclude system sessions.
- **sqlcmd path:** SQL Server 2022 uses `/opt/mssql-tools18/bin/sqlcmd` (with `-C` flag for trust cert). Older images use `/opt/mssql-tools/bin/sqlcmd` (no `-C` flag). The healthcheck tries both.

### Troubleshooting

- **Container won't start:** SQL Server needs 2+ GB RAM. Check `docker stats`. On WSL, ensure WSL2 memory limit is high enough.
- **SA_PASSWORD complexity:** SQL Server requires mixed case + numbers + symbols. "TestPassword123!" meets requirements.
- **Health check slow:** SQL Server takes 20-30s to initialize. The health check has `retries: 10` to handle this.
- **ECONNREFUSED:** Wait for healthy status before running tests.

---

## Sprint 5 - Oracle

**Status:** MERGED (PR #12)
**Driver:** `oracledb` (thin mode — no Oracle Instant Client needed)
**Docker image:** `gvenzl/oracle-xe:21-slim`
**Port:** 11521 (host) → 1521 (container)

### Prerequisites

- Docker with 2+ GB RAM for Oracle XE
- `npm install` includes `oracledb` (already in package.json)
- Oracle XE license: free for development/education

### Docker Setup (in docker-compose.yml)

```yaml
  oracle-test:
    image: gvenzl/oracle-xe:21-slim
    container_name: ai-dba-oracle-test
    restart: unless-stopped
    ports:
      - "11521:1521"
    environment:
      ORACLE_PASSWORD: testpassword
      APP_USER: testuser
      APP_USER_PASSWORD: testpassword
    healthcheck:
      test: ["CMD-SHELL", "echo 'SELECT 1 FROM DUAL;' | sqlplus -s testuser/testpassword@localhost:1521/XEPDB1 2>/dev/null | grep -q '1'"]
      interval: 15s
      timeout: 10s
      retries: 10
```

### Config (in config.yaml.example)

```yaml
  oracle-test:
    type: oracle
    url: oracle://testuser:testpassword@127.0.0.1:11521/XEPDB1
```

### Manual Test Procedure

**Step 1: Start container**
```bash
docker compose up -d oracle-test
docker inspect --format='{{.State.Health.Status}}' ai-dba-oracle-test
# Wait for "healthy" — Oracle XE takes 30-60s to initialize
```

**Step 2: Create test table**
```bash
docker exec ai-dba-oracle-test bash -c "echo 'CREATE TABLE blocking_test (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name VARCHAR2(100), value NUMBER); INSERT INTO blocking_test (name, value) VALUES ('\''alpha'\'',1), ('\''beta'\'',2), ('\''gamma'\'',3); COMMIT;' | sqlplus -s testuser/testpassword@localhost:1521/XEPDB1"
```

**Step 3: Run unit tests**
```bash
npm test
# Expected: 15 test files, 75 tests (includes 4 Oracle URL parser tests)
```

**Step 4: Run integration tests**
```bash
node test/integration-all.mjs
# Expected: 121 tests total, 0 failures (includes 24 Oracle tests). Sprint 8 adds 84 more via `npm run test:integration:sprint8`.
```

**Step 5: CLI tests**
```bash
node dist/index.js --config config.yaml list-engines
# Expected: 5 engines including oracle-test

node dist/index.js --config config.yaml blocking-chains oracle-test
# Expected: "No blocking chains found on oracle-test"
```

**Step 6: REPL tests**
```bash
node dist/index.js --config config.yaml repl
use oracle-test
databases         — should list schemas/users (TESTUSER, SYS, SYSTEM, etc.)
tables            — should list BLOCKING_TEST
describe BLOCKING_TEST — columns: ID (NUMBER, PRI, IDENTITY), NAME (VARCHAR2), VALUE (NUMBER)
indexes BLOCKING_TEST  — SYS_C* primary key index
processes         — active sessions (empty if no SELECT ANY DICTIONARY privilege)
blocking-chains   — no chains (empty if no SELECT ANY DICTIONARY privilege)
sql SELECT * FROM v$version — should return Oracle 21c version (requires SELECT ANY DICTIONARY)
```

**Step 7: Blocking scenario test**

Requires SELECT ANY DICTIONARY privilege for the testuser:
```bash
docker exec ai-dba-oracle-test bash -c "echo 'GRANT SELECT ANY DICTIONARY TO testuser;' | sqlplus -s / as sysdba"
```

```bash
# Session 1 — hold lock
docker exec -i ai-dba-oracle-test bash -c "echo 'SET AUTOCOMMIT OFF
UPDATE blocking_test SET value=999 WHERE id=1;' | sqlplus -s testuser/testpassword@localhost:1521/XEPDB1 &"

sleep 3

# Session 2 — blocked
docker exec -i ai-dba-oracle-test bash -c "echo 'UPDATE blocking_test SET value=888 WHERE id=1;' | sqlplus -s testuser/testpassword@localhost:1521/XEPDB1 &"

sleep 3
```

While both sessions are active:
```bash
node dist/index.js --config config.yaml blocking-chains oracle-test --json
```

**Expected JSON:**
```json
{
  "chains": [{
    "engine_id": "oracle-test",
    "blocking_pid": <number>,
    "blocked_pid": <number>,
    "wait_duration_ms": <positive number>,
    "wait_event": "enq: TX - row lock contention",
    "blocking_query": "UPDATE blocking_test SET value=999 WHERE id=1",
    "blocked_query": "UPDATE blocking_test SET value=888 WHERE id=1",
    "database_name": "TESTUSER",
    "wait_type": "enq",
    "status": "ACTIVE",
    "host_name": "<hostname>",
    "program_name": "sqlplus",
    "login_time": null
  }],
  "count": 1
}
```

### Known Issues

- **v$ permission fallback:** `listProcesses` and `getBlockingChains` require SELECT ANY DICTIONARY. Without it, they return empty arrays (ORA-00942/ORA-01031 caught gracefully). Grant with: `GRANT SELECT ANY DICTIONARY TO testuser;`
- **Bind variable names:** `:table` is a reserved bind variable in oracledb. The connector uses `:tbl` instead. Column aliases (`AS name`) also conflict — the connector uses positional indexing (row[0], row[1], etc.).
- **Uppercase identifiers:** Oracle stores identifiers in uppercase by default. Table names, column names, and index names come back uppercase. The integration test assertions handle both cases.
- **user_objects vs all_objects:** `user_objects` has no `OWNER` column. The connector uses `USER AS schema` for the default case and `all_objects` (which has `OWNER`) for schema-filtered queries.
- **Thin mode:** oracledb thin mode (default in v6+) doesn't need Oracle Instant Client. If thick mode is needed, install Instant Client and call `oracledb.initOracleClient()`.

### Troubleshooting

- **Oracle XE slow startup:** 30-60s is normal. Health check has retries: 10.
- **ORA-12541:** Listener not ready yet. Wait longer.
- **ORA-01017:** Invalid credentials. Check ORACLE_PASSWORD / APP_USER_PASSWORD.
- **ORA-00942 on v$ views:** Needs SELECT ANY DICTIONARY. Grant it or accept empty results.

---

## Sprint 6 - MongoDB

**Status:** MERGED (PR #13)
**Driver:** `mongodb` (official Node.js driver, ESM-native)
**Docker image:** `mongo:7`
**Port:** 12017 (host) → 27017 (container)

### Prerequisites

- Docker
- `npm install` includes `mongodb` (already in package.json)

### Docker Setup (in docker-compose.yml)

```yaml
  mongodb-test:
    image: mongo:7
    container_name: ai-dba-mongodb-test
    restart: unless-stopped
    ports:
      - "12017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: testuser
      MONGO_INITDB_ROOT_PASSWORD: testpassword
      MONGO_INITDB_DATABASE: testdb
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1}).ok' | grep -q '1'"]
      interval: 10s
      timeout: 5s
      retries: 5
```

### Config (in config.yaml.example)

```yaml
  mongodb-test:
    type: mongodb
    url: mongodb://testuser:testpassword@127.0.0.1:12017/testdb?authSource=admin
```

### Manual Test Procedure

**Step 1: Start container**
```bash
docker compose up -d mongodb-test
docker inspect --format='{{.State.Health.Status}}' ai-dba-mongodb-test
# Wait for "healthy"
```

**Step 2: Create test data**
```bash
docker exec ai-dba-mongodb-test mongosh "mongodb://testuser:testpassword@127.0.0.1:27017/testdb?authSource=admin" --quiet --eval 'db.blocking_test.deleteMany({}); db.blocking_test.insertMany([{name:"alpha",value:1},{name:"beta",value:2},{name:"gamma",value:3}]); db.blocking_test.countDocuments()'
# Expected: 3
```

**Step 3: Run unit tests**
```bash
npm test
# Expected: 15 test files, 75 tests (includes 4 MongoDB URL parser tests)
```

**Step 4: Run integration tests**
```bash
node test/integration-all.mjs
# Expected: 121 tests total, 0 failures (includes 24 MongoDB tests). Sprint 8 adds 84 more via `npm run test:integration:sprint8`.
```

**Step 5: CLI tests**
```bash
node dist/index.js --config config.yaml list-engines
# Expected: 5 engines including mongodb-test

node dist/index.js --config config.yaml blocking-chains mongodb-test
# Expected: "No blocking chains found on mongodb-test" (or equivalent for long-running ops)
```

**Step 6: REPL tests**
```bash
node dist/index.js --config config.yaml repl
use mongodb-test
databases         — should list testdb, admin, config, local
tables            — should list collections: blocking_test
describe blocking_test — field info: _id (ObjectId, PRI), name (string), value (number)
indexes blocking_test  — _id_ index (UNIQUE, PRIMARY)
processes         — active connections/ops
blocking-chains   — no chains (or long-running ops if any)
```

**Step 7: Query via JSON command documents**

MongoDB `query()` accepts JSON command documents instead of SQL:
```bash
node dist/index.js --config config.yaml repl
use mongodb-test
# Find documents
sql {"find": "blocking_test", "filter": {}, "limit": 1}

# Count documents
sql {"count": "blocking_test", "filter": {}}

# Distinct values
sql {"distinct": "blocking_test", "field": "name", "filter": {}}

# Ping
sql {"ping": 1}
```

**Step 8: Blocking/long-running ops scenario**

MongoDB doesn't have traditional row locks like SQL databases. Instead, test long-running operations:

```bash
# Start a long-running operation in one session
docker exec ai-dba-mongodb-test mongosh "mongodb://testuser:testpassword@127.0.0.1:27017/testdb?authSource=admin" --eval '
db.blocking_test.find({ $where: "sleep(15000) || true" }).toArray();
' &

sleep 3

# Check for long-running ops
node dist/index.js --config config.yaml blocking-chains mongodb-test --json
```

**Expected:** JSON with long-running op info (opid, secs_running, command, client).

### Known Issues

- **Schema inference is sampled:** `describeTable` infers types from up to 100 sampled documents. If the collection is empty, only `_id` is returned.
- **`_id_` index uniqueness:** MongoDB's default `_id_` index doesn't set `unique: true` in the `listIndexes()` result. The connector checks `idx.name === "_id_"` as a fallback for uniqueness.
- **JSON command API:** `query()` accepts JSON command documents (find, aggregate, count, distinct, ping) instead of SQL. Read-only guard allows only these operations.
- **currentOp privileges:** `listProcesses` and `getBlockingChains` use `db.currentOp()` which may require the `clusterMonitor` or `root` role.

### Troubleshooting

- **MongoDB "blocking" is different:** MongoDB uses document-level locking (WiredTiger) and doesn't have traditional blocking chains. The connector reports long-running operations via `db.currentOp()` instead.
- **Auth failures:** Use `authSource=admin` in the URL when connecting to the root user.
- **mongosh auth format:** Use the full connection URI: `mongosh "mongodb://testuser:testpassword@127.0.0.1:27017/testdb?authSource=admin"`. Don't use bare `mongosh testdb` — auth will fail.

---

## Master Test Checklist

Run this checklist after all sprints are merged:

### Pre-flight
- [ ] `npm install` — no errors
- [ ] `npm run build` — TypeScript compiles, 0 errors
- [ ] `npm test` — 75 unit tests pass
- [ ] `docker compose up -d` — all 5 containers healthy (MySQL 13306, PostgreSQL 15432, SQL Server 11433, Oracle 11521, MongoDB 12017)

### Per-engine verification
For each engine (mysql-test, postgres-test, sqlserver-test, oracle-test, mongodb-test):

- [ ] `list-engines` shows the engine with correct host/port
- [ ] REPL `databases` returns expected databases
- [ ] REPL `tables` returns blocking_test table/collection
- [ ] REPL `describe blocking_test` returns columns with correct types
- [ ] REPL `indexes blocking_test` returns primary key index
- [ ] REPL `processes` returns active connections
- [ ] REPL `blocking-chains` returns "no chains" when idle
- [ ] MCP `databases` tool returns JSON
- [ ] MCP `tables` tool returns JSON
- [ ] MCP `describe-table` tool returns JSON
- [ ] MCP `indexes` tool returns JSON
- [ ] MCP `processes` tool returns JSON
- [ ] MCP `blocking-chains` tool returns JSON

### Sprint 8 features
For each engine (mysql-test, postgres-test, sqlserver-test, oracle-test, mongodb-test):

- [ ] CLI `table-sizes <engineId>` returns table sizes with human-readable formatting
- [ ] CLI `explain <engineId> "SELECT 1"` returns execution plan
- [ ] CLI `slow-queries <engineId>` returns array (may be empty for engines without features)
- [ ] CLI `health-check <engineId>` returns status (healthy/warning/critical)
- [ ] REPL `table-sizes` (alias `ts`) works
- [ ] REPL `explain "SELECT 1"` (alias `exp`) works
- [ ] REPL `slow-queries` (alias `sq`) works
- [ ] REPL `health-check` (alias `hc`) works
- [ ] MCP `table-sizes` tool returns JSON
- [ ] MCP `explain` tool returns JSON
- [ ] MCP `slow-queries` tool returns JSON
- [ ] MCP `health-check` tool returns JSON

### Blocking scenario per engine
- [ ] MySQL — row lock detected, correct PIDs, queries, wait time
- [ ] PostgreSQL — table lock detected, correct PIDs, queries, wait event
- [ ] SQL Server — row lock detected, wait_type = LCK_M_X
- [ ] Oracle — row lock detected, wait_event = enq: TX - row lock contention (requires SELECT ANY DICTIONARY)
- [ ] MongoDB — long-running op detected (if applicable)

### Integration tests
- [ ] `npm run test:integration` — 121 tests pass (Sprints 1-7)
- [ ] `npm run test:integration:sprint8` — 84 tests pass (Sprint 8)

### MCP server
- [ ] `tools/list` returns 10 tools
- [ ] Each tool accepts engineId and returns valid JSON
- [ ] Unknown engineId returns error
- [ ] Unsupported engine type returns error
- [ ] Connector errors are propagated as error responses

---

## Sprint 8 - Query Performance & Health

**Status:** COMPLETE
**Features:** `table-sizes`, `explain`, `slow-queries`, `health-check`

### Prerequisites

- All 5 Docker containers running and healthy
- `npm run build` succeeds with 0 errors
- `npm test` passes (75 unit tests)

### Step 1: Run unit tests

```bash
npm test
# Expected: 15 test files, 75 tests, all passing
```

### Step 2: Run Sprint 8 integration tests

```bash
npm run test:integration:sprint8
# Expected: 84 tests, 0 failures
```

Tests `table-sizes`, `explain`, `slow-queries`, and `health-check` against all 5 live databases. Graceful degradation verified: PostgreSQL returns empty slow queries (no `pg_stat_statements`), Oracle returns empty (no `V$SQLAREA` access), SQL Server returns empty slow queries (no query history yet).

### Step 3: CLI smoke tests

```bash
# Table sizes — human-readable output
node dist/index.js --config config.yaml table-sizes mysql-test
# Expected: Table with columns Table, Rows, Data, Index, Total, Free

# Explain — execution plan
node dist/index.js --config config.yaml explain mysql-test "SELECT * FROM blocking_test WHERE id = 1"
# Expected: JSON or text execution plan

# Explain with analyze (PostgreSQL only — actually executes the query)
node dist/index.js --config config.yaml explain postgres-test "SELECT * FROM blocking_test WHERE id = 1" -a
# Expected: JSON plan with execution stats

# Explain MongoDB (JSON command document)
node dist/index.js --config config.yaml explain mongodb-test '{"find":"blocking_test","filter":{}}'
# Expected: JSON explain output

# Slow queries
node dist/index.js --config config.yaml slow-queries mysql-test
# Expected: Table with Query, Execs, Total, Avg, Max, Rows columns

# Health check
node dist/index.js --config config.yaml health-check mysql-test
# Expected: Status table with 4 checks (connectivity, blocking, processes, slow-queries)
```

### Step 4: REPL tests

```bash
node dist/index.js --config config.yaml repl
use mysql-test

table-sizes         — table sizes with human-readable formatting
ts                  — alias works
explain SELECT 1    — execution plan
exp SELECT 1        — alias works
slow-queries        — slow query list
sq                  — alias works
health-check        — health status (4 checks)
hc                  — alias works

use postgres-test
explain SELECT * FROM blocking_test -a  — EXPLAIN ANALYZE (executes query)

use mongodb-test
explain {"find":"blocking_test","filter":{}}  — MongoDB explain
```

### Step 5: MCP tool verification

```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | timeout 5 node dist/index.js --config config.yaml serve 2>/dev/null
# Expected: 10 tools listed including table-sizes, explain, slow-queries, health-check

echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"table-sizes","arguments":{"engineId":"mysql-test"}},"id":2}' | timeout 5 node dist/index.js --config config.yaml serve 2>/dev/null
# Expected: JSON with table sizes

echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"health-check","arguments":{"engineId":"mysql-test"}},"id":3}' | timeout 5 node dist/index.js --config config.yaml serve 2>/dev/null
# Expected: JSON with status: "healthy" or "warning" and 4 checks
```

### Known Issues

- **PostgreSQL `pg_stat_statements`:** Not installed in the Docker test container by default. `slow-queries` returns empty array (graceful degradation). Install with: `CREATE EXTENSION pg_stat_statements;` (requires `shared_preload_libraries`).
- **Oracle `V$SQLAREA`:** Requires SELECT ANY DICTIONARY. `slow-queries` returns empty if denied.
- **SQL Server `LIMIT`:** SQL Server uses `TOP N`, not `LIMIT N`. The explain integration test uses `SELECT TOP 1` for SQL Server.
- **MySQL `EXPLAIN ANALYZE`:** MySQL doesn't support `EXPLAIN ANALYZE`. The `-a` flag is silently ignored.
- **MongoDB `currentOp`:** Shows currently running ops only (no historical slow query log). `slow-queries` returns ops with `secs_running >= minDurationMs`.