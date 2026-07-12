# AI-DBA

Universal database copilot — diagnostics, operations, and performance analysis via MCP and CLI.

## Features

- **MCP Server** — expose database diagnostics as tools for AI agents (Hermes, Claude Code, etc.)
- **CLI** — one-off commands for scripting and automation
- **Interactive REPL** — explore your databases interactively with standard DBA commands
- **Connection URLs** — connect via `mysql://`, `postgresql://`, `sqlserver://`, `oracle://`, or `mongodb://` URLs (no config file needed)
- **Database-agnostic commands** — `databases`, `tables`, `describe`, `indexes`, `processes` work across engines
- **Multi-engine support** — MySQL, PostgreSQL, SQL Server, Oracle, and MongoDB connectors
- **MySQL blocking chains** — detect and report row-level blocking with full query details
- **Table sizes** — list table/collection sizes with human-readable formatting (`table-sizes`)
- **Explain plans** — execution plan analysis with optional `--analyze` flag (PostgreSQL executes the query)
- **Slow queries** — surface slow query data from engine internals (performance_schema, pg_stat_statements, sys.dm_exec_query_stats, V$SQLAREA, currentOp)
- **Health checks** — orchestrate connectivity, blocking, processes, slow queries, and replication into one status call
- **Kill process** — guided remediation: dry-run proposal, explicit confirm, audit log at `~/.ai-dba/audit.log`
- **Replication status** — normalized role, lag, and status across all engines
- **Server diagnostics** — curated server variables and runtime status metrics
- **SQL guard** — shared validation module rejects destructive SQL before it reaches connectors
- **GitHub Actions CI** — build + test on Node 20/22, runs on every push/PR to main
- **Documentation site** — MkDocs Material with 8 pages, light/dark mode, search

## Documentation

Full docs site live at: https://steveramos21.github.io/ai-dba/

To build docs locally:
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-docs.txt
.venv/bin/mkdocs serve
# Open http://127.0.0.1:8000
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Connect and explore

Option A — **Config file** (for multiple engines):

```bash
cp config.yaml.example config.yaml
# Edit config.yaml with your database credentials
npm run repl
```

Option B — **Connection URL** (no config file needed):

```bash
node dist/index.js repl
# Then: connect mysql://root:password@127.0.0.1:3306/mydb
```

Option C — **Connect via URL** (drops into REPL):

```bash
# MySQL
npm run connect -- 'mysql://root:***@127.0.0.1:3306/mydb'

# PostgreSQL
npm run connect -- 'postgresql://postgres:***@127.0.0.1:5432/mydb'
# Connects and opens interactive REPL
```

## Commands

| Command | Description |
|---------|-------------|
| `serve` | Start MCP server over stdio (for AI agents) |
| `list-engines` | List configured database engines |
| `blocking-chains <engineId>` | Show current blocking chains |
| `table-sizes <engineId> [database]` | List table sizes with human-readable formatting |
| `explain <engineId> <query> [-a]` | Show execution plan (add `-a` for ANALYZE) |
| `slow-queries <engineId> [--limit N] [--min-duration-ms N]` | List slow queries from engine internals |
| `health-check <engineId>` | Run health check (connectivity, blocking, processes, slow queries, replication) |
| `kill-process <engineId> <pid> [--confirm]` | Kill a session (dry-run default, `--confirm` to execute) |
| `replication-status <engineId>` | Show replication status (role, lag, status) |
| `server-variables <engineId>` | List curated server configuration variables |
| `server-status <engineId>` | List curated server runtime status metrics |
| `connect <url>` | Connect to a database via URL |
| `repl` | Interactive REPL for database diagnostics |

### Global Options

| Option | Description | Default |
|--------|-------------|---------|
| `-c, --config <path>` | Path to config.yaml | `config.yaml` |
| `-V, --version` | Show version | — |
| `-h, --help` | Show help | — |

### `connect <url>`

Connect to a database via URL and open an interactive REPL. No config file needed. Supports `mysql://`, `postgresql://`, and `postgres://` URL schemes.

```bash
# MySQL
npm run connect -- 'mysql://root:***@127.0.0.1:3306/mydb'

# PostgreSQL
npm run connect -- 'postgresql://postgres:***@127.0.0.1:5432/mydb'

# With --type override
npm run connect -- 'postgresql://user:***@host:5432/db' --type postgres
```

This connects, verifies the connection, then drops you into the REPL where you can run `databases`, `tables`, `describe`, `indexes`, `processes`, etc.

### `blocking-chains`

```bash
ai-dba blocking-chains <engineId>       # Table output
ai-dba blocking-chains <engineId> --json # JSON output
```

Detects blocking chains across MySQL and PostgreSQL. Returns a list of blocking chain entries:

| Field | Description |
|-------|-------------|
| `engine_id` | Engine identifier from config |
| `blocking_pid` | Process ID holding the lock |
| `blocked_pid` | Process ID waiting for the lock |
| `wait_duration_ms` | How long the blocked session has been waiting |
| `wait_event` | Wait event name (engine-specific) |
| `blocking_query` | SQL statement holding the lock |
| `blocked_query` | SQL statement waiting for the lock |
| `database_name` | Database context |
| `wait_type` | Wait type classification |
| `status` | Session status |
| `host_name` | Client host address |
| `program_name` | Client program name |
| `login_time` | Session login timestamp |

**MySQL** uses `INNODB_LOCK_WAITS` + `INNODB_TRX` + `performance_schema.threads` (4-join query). `wait_type` and `program_name` are NULL for MySQL (not exposed in the query).

**PostgreSQL** uses `pg_blocking_pids()` + `pg_stat_activity` with `query_start` for wait duration. All 12 fields are populated natively.

**Error cases:**

- Unknown engine ID → `Unknown engine "x". Available: mysql-primary`
- Unsupported engine type → error from the connector's `getBlockingChains()` method

### `repl`

```bash
ai-dba repl                # Uses config.yaml
ai-dba repl                # No config — start empty, use connect
```

Interactive commands:

| Command | Alias | Description |
|---------|-------|-------------|
| `help` | | Show available commands |
| `connect <url>` | | Connect to a database via URL |
| `databases` | `db` | List databases on the server |
| `tables` | `dt` | List tables (with rows, size, engine) |
| `describe <table>` | `desc` | Show column details (type, nullable, key, default) |
| `indexes <table>` | `idx` | List indexes on a table |
| `processes` | `ps` | Show active connections/processes |
| `engines` | `ls` | List configured engines (current marked with *) |
| `use <engineId>` | | Switch to a different engine |
| `status` | `s` | Show connection details for current engine |
| `blocking-chains` | `bc` | Show blocking chains on current engine |
| `sql <statement>` | | Run a raw SQL query (escape hatch) |
| `quit` | `q`, `exit` | Exit the REPL |

SQL keywords are auto-detected — just type `SHOW DATABASES` or `SELECT * FROM users` directly.

**Example session:**

```
AI-DBA REPL — type 'help' for commands
No engines configured. Use: connect <url>

ai-dba[no-engine]> connect mysql://root:password@127.0.0.1:13306/testdb
Connected to 127.0.0.1-testdb
  mysql://root:***@127.0.0.1:13306/testdb

ai-dba[127.0.0.1-testdb]> databases
┌────────────────────┐
│ Database           │
├────────────────────┤
│ information_schema │
│ testdb             │
└────────────────────┘
2 database(s)

ai-dba[127.0.0.1-testdb]> tables
┌────────────────┬──────┬─────────┬─────────┬─────────────────────┐
│ Table          │ Rows  │ Size    │ Engine  │ Collation           │
├────────────────┼──────┼─────────┼─────────┼─────────────────────┤
│ blocking_test  │ 3     │ 16.0 KB │ InnoDB  │ utf8mb4_0900_ai_ci  │
└────────────────┴──────┴─────────┴─────────┴─────────────────────┘
1 table(s)

ai-dba[127.0.0.1-testdb]> describe blocking_test
┌─────────┬──────────────┬──────┬─────┬─────────┬────────────────┐
│ Column  │ Type         │ Null │ Key │ Default  │ Extra          │
├─────────┼──────────────┼──────┼─────┼─────────┼────────────────┤
│ id      │ int          │ NO   │ PRI │ NULL     │ auto_increment │
│ name    │ varchar(100) │ YES  │     │ NULL     │                │
│ value   │ int          │ YES  │     │ NULL     │                │
└─────────┴──────────────┴──────┴─────┴─────────┴────────────────┘

ai-dba[127.0.0.1-testdb]> processes
┌──────┬──────┬──────────────────────┬─────────┬─────────┬──────┬─────────────┐
│ PID  │ User │ Host                 │ DB      │ Command │ Time │ State       │
├──────┼──────┼──────────────────────┼─────────┼─────────┼──────┼─────────────┤
│ 5    │ root │ 172.23.0.1:54312     │ testdb  │ Query   │ 0s   │ starting    │
└──────┴──────┴──────────────────────┴─────────┴─────────┴──────┴─────────────┘
1 process(es)
```

### `serve`

Starts an MCP server over stdio. Used by AI agents to call database diagnostics tools.

**MCP configuration** (e.g., `~/.hermes/config.yaml`):

```json
{
  "mcpServers": {
    "ai-dba-diagnostics": {
      "command": "node",
      "args": ["/path/to/ai-dba/dist/index.js", "serve", "--config", "/path/to/ai-dba/config.yaml"]
    }
  }
}
```

The server exposes fourteen tools:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `blocking-chains` | `engineId` (string, required) | Show current blocking chains |
| `databases` | `engineId` (string, required) | List databases/schemas on the server |
| `tables` | `engineId` (string, required), `database` (string, optional) | List tables in a database/schema |
| `describe-table` | `engineId` (string, required), `table` (string, required), `database` (string, optional) | Show column metadata for a table |
| `indexes` | `engineId` (string, required), `table` (string, required), `database` (string, optional) | List indexes on a table |
| `processes` | `engineId` (string, required) | List active database connections/processes |
| `table-sizes` | `engineId` (string, required), `database` (string, optional) | List table sizes with data/index/total breakdown |
| `explain` | `engineId` (string, required), `query` (string, required), `analyze` (boolean, optional) | Show execution plan for a query |
| `slow-queries` | `engineId` (string, required), `limit` (int, optional), `minDurationMs` (int, optional) | List slow queries from engine internals |
| `health-check` | `engineId` (string, required) | Run health check (connectivity, blocking, processes, slow queries, replication) |
| `kill-process` | `engineId` (string, required), `pid` (string, required), `confirm` (boolean, optional) | Kill a session (dry-run default, `confirm=true` to execute, requires `allowWriteOps`) |
| `replication-status` | `engineId` (string, required) | Get replication status (role, lagSeconds, status, errorMessage) |
| `server-variables` | `engineId` (string, required) | List curated server configuration variables |
| `server-status` | `engineId` (string, required) | List curated server runtime status metrics |

All tools return JSON.

## Docker Test Environment

A Docker Compose file is included for local testing with MySQL 8.0 and PostgreSQL 16.

### Start databases

```bash
docker compose up -d
```

Wait until healthy:

```bash
docker inspect --format='{{.State.Health.Status}}' ai-dba-mysql-test
docker inspect --format='{{.State.Health.Status}}' ai-dba-postgres-test
# Repeat until both show "healthy"
```

### Seed MySQL test data

```bash
docker exec ai-dba-mysql-test mysql -uroot -ptestpassword testdb \
  -e "CREATE TABLE IF NOT EXISTS blocking_test (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT); INSERT IGNORE INTO blocking_test (name, value) VALUES ('alpha', 1), ('beta', 2), ('gamma', 3);"
```

### Create a test config

```bash
cp config.yaml.example config.yaml
```

The example config points to both Docker MySQL on port 13306 and PostgreSQL on port 15432.

### Test blocking detection

MySQL blocking scenario:

```bash
node test/test-blocking.mjs
```

PostgreSQL blocking scenario:

```bash
# Seed test data first
docker exec ai-dba-postgres-test psql -U postgres -d testdb \
  -c "CREATE TABLE IF NOT EXISTS blocking_test (id SERIAL PRIMARY KEY, value INT); INSERT INTO blocking_test (value) VALUES (1) ON CONFLICT DO NOTHING;"

# Run the test
node test/test-blocking-postgres.mjs
```

### Stop databases

```bash
docker compose down
```

Add `-v` to also delete the data volume.

### Integration tests (require Docker)

```bash
# All connector methods against live MySQL + PostgreSQL (49 tests)
npm run test:integration

# Live blocking scenarios — creates real locks, validates detection (21 tests)
npm run test:blocking
```

These tests catch bugs that mocked unit tests cannot — they exercise real SQL against MySQL 8.0 and PostgreSQL 16.

## Configuration

`config.yaml` format:

### Connection URL (recommended)

```yaml
engines:
  mysql-prod:
    type: mysql
    url: mysql://readonly:***@prod-db.internal:3306/app_db?ssl=true

  postgres-prod:
    type: postgres
    url: postgresql://readonly:***@prod-db.internal:5432/app_db?sslmode=require
```

The `url` field takes priority over individual fields. MySQL supports additional URL params:
- `ssl=true` — enable SSL with certificate verification
- `ssl={"rejectUnauthorized":false}` — custom SSL options (JSON)
- `connectionLimit=10` — pool size (default: 5)

PostgreSQL URLs are passed directly to `pg.Pool({ connectionString })`, so any `pg`-supported parameter works (`sslmode`, `connect_timeout`, etc.).

### Individual fields (legacy)

```yaml
engines:
  <engine-id>:
    type: mysql          # or postgres, sqlserver, oracle, mongodb
    host: 127.0.0.1      # Hostname or IP (MySQL only)
    port: 3306            # Port (MySQL only)
    user: root            # Database user (MySQL only)
    password: secret      # Password (MySQL only)
    database: mydb        # Default database (MySQL only)
```

Note: Individual fields are only supported for MySQL. PostgreSQL requires a connection URL (`url` field).

Multiple engines are supported:

```yaml
engines:
  mysql-prod:
    type: mysql
    url: mysql://readonly:***@prod-db.internal:3306/app_db?ssl=true
  mysql-staging:
    type: mysql
    host: staging-db.internal
    port: 3306
    user: readonly
    password: ${MYSQL_STAGING_PASSWORD}
    database: app_db
  postgres-analytics:
    type: postgres
    url: postgresql://readonly:***@analytics-db.internal:5432/warehouse?sslmode=require
```

**Security:** Add `config.yaml` to `.gitignore` (already included by default).

## Architecture

```
src/
  index.ts              CLI entry point (commander, REPL)
  server.ts             MCP server setup + connector map
  config.ts             YAML config loader with URL parsing
  connector.ts          DatabaseConnector interface + shared types (14 methods, BlockingChain, TableSizeInfo, ExplainResult, SlowQueryInfo, KillResult, ReplicationStatus, HealthCheckResult)
  sql-guard.ts          Shared SQL validation (validateReadOnlySql, validateExplainQuery, isJsonCommand)
  audit.ts              JSONL audit log writer (~/.ai-dba/audit.log)
  connectors/
    mysql.ts            MySQLConnector (implements DatabaseConnector)
    postgres.ts         PostgreSQLConnector (implements DatabaseConnector)
    sqlserver.ts        SqlServerConnector (implements DatabaseConnector)
    oracle.ts           OracleConnector (implements DatabaseConnector)
    mongodb.ts          MongoDbConnector (implements DatabaseConnector)
  tools/
    blocking-chains.ts  MCP tool — blocking chain diagnostics
    databases.ts        MCP tool — list databases/schemas
    tables.ts           MCP tool — list tables
    describe-table.ts   MCP tool — column metadata
    indexes.ts          MCP tool — list indexes
    processes.ts        MCP tool — active processes/connections
    table-sizes.ts      MCP tool — table size breakdown
    explain.ts          MCP tool — execution plans
    slow-queries.ts     MCP tool — slow query analysis
    health-check.ts     MCP tool — orchestrated health check (5 checks)
    kill-process.ts     MCP tool — kill session (dry-run + confirm + audit)
    replication-status.ts MCP tool — normalized replication status
    server-variables.ts MCP tool — curated server config variables
    server-status.ts    MCP tool — curated server runtime metrics
```

- **DatabaseConnector interface** — 14 methods: `listDatabases`, `listTables`, `describeTable`, `listIndexes`, `listProcesses`, `query`, `getBlockingChains`, `listTableSizes`, `explainQuery`, `listSlowQueries`, `killProcess`, `listReplicationStatus`, `listServerVariables`, `listServerStatus`. All 5 engines implement the interface.
- **sql-guard.ts** — shared validation module used by CLI, REPL, and MCP tool paths. Rejects destructive SQL (INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, MERGE, GRANT, REVOKE) using `\b` word-boundary regex.
- **Lazy imports** — MCP SDK, mysql2, and pg are loaded dynamically only when needed. CLI commands like `list-engines` start instantly without loading database drivers.
- **Lazy connection pools** — Database connections are created on first use, not at startup.
- **One tool per file** — each `src/tools/*.ts` file is self-contained (schema + handler). Adding a new tool means adding a new file and registering it in `server.ts`.
- **Graceful degradation** — `slow-queries` and `explain` return empty results when engine features are unavailable (extension not installed, permission denied) rather than throwing errors.
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs build + unit tests on Node 20/22 for every push/PR to main.

## Requirements

- Node.js 18+
- MySQL 8.0+ (with `performance_schema` enabled, which is the default)
- PostgreSQL 12+ (for PostgreSQL connector)

## License

MIT