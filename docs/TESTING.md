# AI-DBA Manual Testing Guide

This guide covers manual testing procedures for all sprints. Run through each section after the corresponding sprint is merged to verify functionality against live databases.

## Quick Reference

| Sprint | Scope | Status | Test Doc |
|--------|-------|--------|----------|
| 1 | Blocking chains (MySQL) | MERGED | [Sprint 1-3 Tests](#sprints-1-3-merged) |
| 2 | PostgreSQL connector | MERGED | [Sprint 1-3 Tests](#sprints-1-3-merged) |
| 3 | MCP DBA tools + CI | MERGED | [Sprint 1-3 Tests](#sprints-1-3-merged) |
| 4 | SQL Server connector | PLANNED | [Sprint 4 — SQL Server](#sprint-4--sql-server) |
| 5 | Oracle connector | PLANNED | [Sprint 5 — Oracle](#sprint-5--oracle) |
| 6 | MongoDB connector | PLANNED | [Sprint 6 — MongoDB](#sprint-6--mongodb) |
| 7 | Documentation site | PLANNED | [Sprint 7 — Docs Site](#sprint-7--docs-site) |

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

These are already built and merged. Run these tests to verify the current state before starting Sprint 4.

### 1. Unit Tests (no Docker needed)

```bash
npm test
```

**Expected:** 7 test files, 27 tests, all passing. Duration ~10s.

### 2. Integration Tests (Docker required)

Start containers:
```bash
docker compose up -d
# Wait for healthy
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
npm run test:integration
```
**Expected:** 49 tests, 0 failures. Tests all connector methods (listDatabases, listTables, describeTable, listIndexes, listProcesses, query, getBlockingChains) against live MySQL 8.0 and PostgreSQL 16.

### 3. Live Blocking Scenario Tests

```bash
npm run test:blocking
```
**Expected:** 21 tests, 0 failures. Creates real row locks on MySQL and table locks on PostgreSQL, then verifies blocking-chains detection returns correct PIDs, queries, wait duration, and database names.

### 4. CLI Smoke Tests

```bash
# Version
node dist/index.js --version
# Expected: 1.0.0

# List engines (uses config.yaml.example)
node dist/index.js --config config.yaml.example list-engines
# Expected: Table with mysql-test and postgres-test rows, PostgreSQL URL properly masked

# Blocking chains (no active blocks)
node dist/index.js --config config.yaml blocking-chains mysql-test
# Expected: "No blocking chains found on mysql-test"

node dist/index.js --config config.yaml blocking-chains postgres-test
# Expected: "No blocking chains found on postgres-test"
```

### 5. REPL Smoke Test

```bash
node dist/index.js --config config.yaml repl
```

Type these commands and verify output:
```
help              — shows command list
engines           — table with both engines, * on current
use postgres-test  — "Switched to postgres-test"
databases         — table with testdb, postgres, etc.
tables            — table with blocking_test
describe blocking_test — columns: id (PRI, auto_increment), value
indexes blocking_test  — PRIMARY index on id
processes         — list of active connections
blocking-chains   — "No blocking chains."
quit              — "Bye."
```

### 6. MCP Server Smoke Test

```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | timeout 5 node dist/index.js --config config.yaml serve 2>/dev/null
```
**Expected:** JSON response listing 6 tools: blocking-chains, databases, tables, describe-table, indexes, processes.

---

## Sprint 4 — SQL Server

**Status:** PLANNED
**Driver:** `tedious` (raw driver, matches existing pattern of using mysql2/pg directly)
**Docker image:** `mcr.microsoft.com/mssql/server:2022-latest`
**Port:** 11433 (host) → 1433 (container)

### Prerequisites

- Docker with 2+ GB RAM available for SQL Server container
- `npm install tedious` (will be done during sprint implementation)

### Docker Setup (will be added to docker-compose.yml)

```yaml
  sqlserver-test:
    image: mcr.microsoft.com/mssql/server:2022-latest
    container_name: ai-dba-sqlserver-test
    restart: unless-stopped
    ports:
      - "11433:1433"
    environment:
      ACCEPT_EULA: "Y"
      SA_PASSWORD: "TestPassword123!"
      MSSQL_PID: "Express"
    healthcheck:
      test: ["CMD-SHELL", "/opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' -Q 'SELECT 1'"]
      interval: 10s
      timeout: 5s
      retries: 10
```

### Config (will be added to config.yaml)

```yaml
  sqlserver-test:
    type: sqlserver
    url: sqlserver://sa:TestPassword123!@127.0.0.1:11433/testdb
```

### Manual Test Procedure

**Step 1: Start containers**
```bash
docker compose up -d
docker inspect --format='{{.State.Health.Status}}' ai-dba-sqlserver-test
# Wait for "healthy" — SQL Server takes 20-30s to initialize
```

**Step 2: Create test database and table**
```bash
docker exec ai-dba-sqlserver-test /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' \
  -Q "CREATE DATABASE testdb; USE testdb; CREATE TABLE blocking_test (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100), value INT); INSERT INTO blocking_test (name, value) VALUES ('alpha',1),('beta',2),('gamma',3);"
```

**Step 3: Run unit tests**
```bash
npm test
# Expected: 8+ test files, 30+ tests (existing 27 + new SQL Server tests)
```

**Step 4: Run integration tests**
```bash
npm run test:integration
# Expected: 60+ tests (existing 49 + new SQL Server tests)
```

**Step 5: CLI tests**
```bash
node dist/index.js --config config.yaml list-engines
# Expected: 3 engines (mysql-test, postgres-test, sqlserver-test)

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
describe blocking_test — columns: id (INT, PRI, IDENTITY), name (NVARCHAR), value (INT)
indexes blocking_test  — PRIMARY key index on id
processes         — active connections
blocking-chains   — no chains
sql SELECT @@VERSION — should return SQL Server 2022 version string
```

**Step 7: Blocking scenario test**

Open two SQL Server sessions:
```bash
# Session 1 — hold lock
docker exec -i ai-dba-sqlserver-test /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' \
  -Q "USE testdb; BEGIN TRAN; UPDATE blocking_test SET value=999 WHERE id=1; WAITFOR DELAY '00:00:15'; ROLLBACK TRAN;"

# Session 2 (in another terminal, immediately) — blocked
docker exec -i ai-dba-sqlserver-test /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P 'TestPassword123!' \
  -Q "USE testdb; UPDATE blocking_test SET value=888 WHERE id=1;"
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

### Troubleshooting

- **Container won't start:** SQL Server needs 2+ GB RAM. Check `docker stats`. On WSL, ensure WSL2 memory limit is high enough.
- **SA_PASSWORD complexity:** SQL Server requires mixed case + numbers + symbols. "TestPassword123!" meets requirements.
- **Health check slow:** SQL Server takes 20-30s to initialize. The health check has `retries: 10` to handle this.
- **ECONNREFUSED:** Wait for healthy status before running tests.

---

## Sprint 5 — Oracle

**Status:** PLANNED
**Driver:** `oracledb` (node-oracledb thin mode — no Oracle client needed)
**Docker image:** `gvenzl/oracle-xe:21-slim` (smaller than official Oracle image)
**Port:** 11521 (host) → 1521 (container)

### Prerequisites

- Docker with 2+ GB RAM for Oracle XE
- `npm install oracledb` (thin mode — no Oracle Instant Client needed)
- Oracle XE license: free for development/education

### Docker Setup (will be added to docker-compose.yml)

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
      test: ["CMD-SHELL", "echo 'SELECT 1 FROM DUAL;' | sqlplus -s testuser/testpassword@localhost:1521/XEPDB1"]
      interval: 15s
      timeout: 10s
      retries: 10
```

### Config (will be added to config.yaml)

```yaml
  oracle-test:
    type: oracle
    url: oracle://testuser:testpassword@127.0.0.1:11521/XEPDB1
```

### Manual Test Procedure

**Step 1: Start containers**
```bash
docker compose up -d
docker inspect --format='{{.State.Health.Status}}' ai-dba-oracle-test
# Wait for "healthy" — Oracle XE takes 30-60s to initialize
```

**Step 2: Create test table**
```bash
docker exec ai-dba-oracle-test sqlplus testuser/testpassword@localhost:1521/XEPDB1 << 'SQL'
CREATE TABLE blocking_test (
  id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR2(100),
  value NUMBER
);
INSERT INTO blocking_test (name, value) VALUES ('alpha',1), ('beta',2), ('gamma',3);
COMMIT;
SQL
```

**Step 3: Run unit tests**
```bash
npm test
# Expected: 9+ test files, 34+ tests
```

**Step 4: Run integration tests**
```bash
npm run test:integration
# Expected: 70+ tests
```

**Step 5: CLI tests**
```bash
node dist/index.js --config config.yaml list-engines
# Expected: 4 engines including oracle-test

node dist/index.js --config config.yaml blocking-chains oracle-test
# Expected: "No blocking chains found on oracle-test"
```

**Step 6: REPL tests**
```bash
node dist/index.js --config config.yaml repl
use oracle-test
databases         — should list schemas (TESTUSER, SYS, SYSTEM, etc.)
tables            — should list BLOCKING_TEST
describe BLOCKING_TEST — columns: ID (NUMBER, PRI, IDENTITY), NAME (VARCHAR2), VALUE (NUMBER)
indexes BLOCKING_TEST  — SYS_C* primary key index
processes         — active sessions
blocking-chains   — no chains
sql SELECT * FROM v$version — should return Oracle 21c version
```

**Step 7: Blocking scenario test**

```bash
# Session 1 — hold lock
docker exec -i ai-dba-oracle-test sqlplus testuser/testpassword@localhost:1521/XEPDB1 << 'SQL'
SET AUTOCOMMIT OFF
UPDATE blocking_test SET value=999 WHERE id=1;
-- Don't commit — lock held
SQL &

sleep 3

# Session 2 — blocked
docker exec -i ai-dba-oracle-test sqlplus testuser/testpassword@localhost:1521/XEPDB1 \
  -L "UPDATE blocking_test SET value=888 WHERE id=1;" &

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
    "database_name": "XEPDB1",
    "wait_type": "enq",
    "status": "ACTIVE",
    "host_name": "<hostname>",
    "program_name": "sqlplus",
    "login_time": "<timestamp>"
  }],
  "count": 1
}
```

### Troubleshooting

- **Oracle XE slow startup:** 30-60s is normal. Health check has retries: 10.
- **ORA-12541:** Listener not ready yet. Wait longer.
- **ORA-01017:** Invalid credentials. Check ORACLE_PASSWORD / APP_USER_PASSWORD.
- **Thin mode vs thick mode:** oracledb thin mode (default in v6+) doesn't need Oracle Instant Client. If thick mode is needed, install Instant Client and call `oracledb.initOracleClient()`.
- **Table names uppercase:** Oracle stores identifiers in uppercase. Use `BLOCKING_TEST` not `blocking_test` in queries.

---

## Sprint 6 — MongoDB

**Status:** PLANNED
**Driver:** `mongodb` (official Node.js driver)
**Docker image:** `mongo:7`
**Port:** 12017 (host) → 27017 (container)

### Prerequisites

- Docker
- `npm install mongodb`

### Docker Setup (will be added to docker-compose.yml)

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
      test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1})'"]
      interval: 10s
      timeout: 5s
      retries: 5
```

### Config (will be added to config.yaml)

```yaml
  mongodb-test:
    type: mongodb
    url: mongodb://testuser:testpassword@127.0.0.1:12017/testdb?authSource=admin
```

### Manual Test Procedure

**Step 1: Start containers**
```bash
docker compose up -d
docker inspect --format='{{.State.Health.Status}}' ai-dba-mongodb-test
# Wait for "healthy"
```

**Step 2: Create test data**
```bash
docker exec ai-dba-mongodb-test mongosh testdb --eval '
db.blocking_test.insertMany([
  { name: "alpha", value: 1 },
  { name: "beta", value: 2 },
  { name: "gamma", value: 3 }
]);
db.blocking_test.createIndex({ name: 1 }, { unique: true });
'
```

**Step 3: Run unit tests**
```bash
npm test
# Expected: 10+ test files, 38+ tests
```

**Step 4: Run integration tests**
```bash
npm run test:integration
# Expected: 85+ tests
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
describe blocking_test — field info (name: String, value: Int32, _id: ObjectId)
indexes blocking_test  — _id_ index, name_1 unique index
processes         — active connections/ops
blocking-chains   — no chains (or long-running ops if any)
sql { ping: 1 }   — should return { ok: 1 } (MongoDB-specific query support)
```

**Step 7: Blocking/long-running ops scenario**

MongoDB doesn't have traditional row locks like SQL databases. Instead, test long-running operations:

```bash
# Start a long-running operation in one session
docker exec ai-dba-mongodb-test mongosh testdb --eval '
db.blocking_test.find({ $where: "sleep(15000) || true" }).toArray();
' &

sleep 3

# Check for long-running ops
node dist/index.js --config config.yaml blocking-chains mongodb-test --json
```

**Expected:** JSON with long-running op info (opid, secs_running, command, client).

### Troubleshooting

- **MongoDB "blocking" is different:** MongoDB uses document-level locking (WiredTiger) and doesn't have traditional blocking chains. The connector will report long-running operations via `db.currentOp()` instead.
- **Auth failures:** Use `authSource=admin` in the URL when connecting to admin user.
- **describe-table limitations:** MongoDB is schemaless. The connector will infer types from a sample of documents, not from a schema definition.

---

## Sprint 7 — Docs Site

**Status:** PLANNED
**Tool:** MkDocs Material (simpler than Docusaurus, no Node build needed, Python-based)

### Prerequisites

- Python 3 with pip
- `pip install mkdocs mkdocs-material`

### Manual Test Procedure

**Step 1: Build site**
```bash
cd /mnt/d/ai-dba
mkdocs serve
# Open http://127.0.0.1:8000
```

**Step 2: Verify pages**

| Page | Content to verify |
|------|-------------------|
| Home | Project overview, quick start |
| Getting Started | Install, build, first connection |
| CLI Reference | All commands with examples |
| REPL Reference | All REPL commands + aliases |
| MCP Integration | Tool list, config examples for Hermes/Claude/Cursor |
| Connectors | MySQL, PostgreSQL, SQL Server, Oracle, MongoDB sections |
| Blocking Chains | How detection works per engine, field mappings |
| Configuration | YAML format, URL formats, individual fields |
| API Reference | DatabaseConnector interface, types |
| Testing | Unit tests, integration tests, blocking tests |

**Step 3: Verify navigation**

- Sidebar collapses/expands correctly
- Search works (type "blocking" — should show blocking chains page)
- Dark/light mode toggle
- Mobile responsive (resize browser to phone width)
- Code blocks have copy buttons

**Step 4: Build static site**
```bash
mkdocs build --strict
# Expected: no warnings, site/ directory created
```

**Step 5: Deploy (optional)**
```bash
mkdocs gh-deploy
# Deploys to https://steveramos21.github.io/ai-dba/
```

### Troubleshooting

- **mkdocs not found:** `pip install mkdocs mkdocs-material`
- **Build warnings:** Run with `--strict` — any broken links or missing images will fail
- **Python not available on Windows host:** Run mkdocs from WSL

---

## Master Test Checklist

Run this checklist after all sprints are merged:

### Pre-flight
- [ ] `npm install` — no errors
- [ ] `npm run build` — TypeScript compiles, 0 errors
- [ ] `npm test` — all unit tests pass
- [ ] `docker compose up -d` — all 5 containers healthy (MySQL, PostgreSQL, SQL Server, Oracle, MongoDB)

### Per-engine verification
For each engine (mysql-test, postgres-test, sqlserver-test, oracle-test, mongodb-test):

- [ ] `list-engines` shows the engine with correct host/port
- [ ] REPL `databases` returns expected databases
- [ ] REPL `tables` returns blocking_test table
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

### Blocking scenario per engine
- [ ] MySQL — row lock detected, correct PIDs, queries, wait time
- [ ] PostgreSQL — table lock detected, correct PIDs, queries, wait event
- [ ] SQL Server — row lock detected, wait_type = LCK_M_X
- [ ] Oracle — row lock detected, wait_event = enq: TX - row lock contention
- [ ] MongoDB — long-running op detected (if applicable)

### Integration tests
- [ ] `npm run test:integration` — all tests pass
- [ ] `npm run test:blocking` — all blocking scenario tests pass

### MCP server
- [ ] `tools/list` returns 6 tools
- [ ] Each tool accepts engineId and returns valid JSON
- [ ] Unknown engineId returns error
- [ ] Unsupported engine type returns error
- [ ] Connector errors are propagated as error responses

### CI
- [ ] GitHub Actions CI runs on push
- [ ] Build + unit tests pass on Node 20 and 22
- [ ] CLI entry point verification passes

### Documentation
- [ ] MkDocs site builds with `--strict`
- [ ] All pages render correctly
- [ ] Search works
- [ ] Code examples are accurate and copy-pasteable