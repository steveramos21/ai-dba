# AI-DBA

Universal database copilot — diagnostics, operations, and performance analysis via MCP and CLI.

## Features

- **MCP Server** — expose database diagnostics as tools for AI agents (Hermes, Claude Code, etc.)
- **CLI** — one-off commands for scripting and automation
- **Interactive REPL** — explore your databases interactively with standard DBA commands
- **Connection URLs** — connect via `mysql://user:pass@host:port/db?ssl=true` (no config file needed)
- **Database-agnostic commands** — `databases`, `tables`, `describe`, `indexes`, `processes` work across engines
- **MySQL blocking chains** — detect and report row-level blocking with full query details

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

Option C — **One-shot command**:

```bash
node dist/index.js connect 'mysql://root:password@127.0.0.1:3306/mydb'
```

## Commands

| Command | Description |
|---------|-------------|
| `serve` | Start MCP server over stdio (for AI agents) |
| `list-engines` | List configured database engines |
| `blocking-chains <engineId>` | Show current blocking chains |
| `connect <url>` | Connect to a database via URL |
| `repl` | Interactive REPL for database diagnostics |

### Global Options

| Option | Description | Default |
|--------|-------------|---------|
| `-c, --config <path>` | Path to config.yaml | `config.yaml` |
| `-V, --version` | Show version | — |
| `-h, --help` | Show help | — |

### `connect <url>`

Connect to a database via URL and run diagnostics. No config file needed.

```bash
ai-dba connect 'mysql://root:password@127.0.0.1:3306/mydb'
ai-dba connect 'mysql://readonly:***@prod-db.internal:3306/app_db?ssl=true'
```

### `blocking-chains`

```bash
ai-dba blocking-chains <engineId>       # Table output
ai-dba blocking-chains <engineId> --json # JSON output
```

Detects row-level blocking chains using MySQL `performance_schema.data_lock_waits`. Returns:

| Field | Description |
|-------|-------------|
| `blocking_pid` | Process ID holding the lock |
| `blocked_pid` | Process ID waiting for the lock |
| `wait_duration_ms` | How long the blocked session has been waiting |
| `wait_event` | Type of wait event |
| `blocking_query` | SQL statement holding the lock |
| `blocked_query` | SQL statement waiting for the lock |
| `database_name` | Database context |
| `wait_type` | Lock type (e.g. "Sleep holding lock") |
| `status` | Thread status |
| `host_name` | Client hostname |
| `program_name` | Client program name |

**Error cases:**

- Unknown engine ID → `Unknown engine "x". Available: mysql-primary`
- Unsupported engine type → `Engine "x" is type "postgres". Only MySQL is currently supported.`
- `performance_schema` disabled → error message telling user to enable it

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

The server exposes one tool:

- **`blocking-chains`** — parameters: `engineId` (string, required)

## Docker Test Environment

A Docker Compose file is included for local testing with MySQL 8.0.

### Start MySQL

```bash
docker compose up -d
```

Wait until healthy:

```bash
docker inspect --format='{{.State.Health.Status}}' ai-dba-mysql-test
# Repeat until "healthy"
```

### Seed test data

```bash
docker exec ai-dba-mysql-test mysql -uroot -ptestpassword testdb \
  -e "CREATE TABLE IF NOT EXISTS blocking_test (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT); INSERT IGNORE INTO blocking_test (name, value) VALUES ('alpha', 1), ('beta', 2), ('gamma', 3);"
```

### Create a test config

```bash
cp config.yaml.example config.yaml
```

The example config already points to the Docker MySQL on port 13306.

### Test blocking detection

An automated test script creates a real blocking scenario and verifies detection:

```bash
node test/test-blocking.mjs
```

### Stop MySQL

```bash
docker compose down
```

Add `-v` to also delete the data volume.

## Configuration

`config.yaml` format:

### Connection URL (recommended)

```yaml
engines:
  mysql-prod:
    type: mysql
    url: mysql://readonly:***@prod-db.internal:3306/app_db?ssl=true
```

The `url` field takes priority over individual fields. Supported URL params:
- `ssl=true` — enable SSL with certificate verification
- `ssl={"rejectUnauthorized":false}` — custom SSL options (JSON)
- `connectionLimit=10` — pool size (default: 5)

### Individual fields (legacy)

```yaml
engines:
  <engine-id>:
    type: mysql          # Engine type (only mysql supported currently)
    host: 127.0.0.1      # Hostname or IP
    port: 3306            # Port
    user: root            # Database user
    password: secret      # Password
    database: mydb        # Default database
```

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
```

**Security:** Add `config.yaml` to `.gitignore` (already included by default).

## Architecture

```
src/
  index.ts              CLI entry point (commander, REPL)
  server.ts             MCP server setup
  config.ts             YAML config loader with URL parsing
  connector.ts          DatabaseConnector interface (engine-agnostic)
  types.ts              Shared TypeScript types
  connectors/
    mysql.ts            MySQLConnector (implements DatabaseConnector)
  tools/
    blocking-chains.ts  MCP tool definition + handler
```

- **DatabaseConnector interface** — standard commands (`databases`, `tables`, `describe`, `indexes`, `processes`, `query`) that work across engines. Add PostgreSQL or SQL Server by implementing the interface.
- **Lazy imports** — MCP SDK and mysql2 are loaded dynamically only when needed. CLI commands like `list-engines` start instantly without loading database drivers.
- **Lazy connection pools** — MySQL connections are created on first use, not at startup.
- **One tool per file** — `src/tools/blocking-chains.ts` is self-contained (schema + handler). Adding a new tool means adding a new file and registering it in `server.ts`.

## Requirements

- Node.js 18+
- MySQL 8.0+ (with `performance_schema` enabled, which is the default)

## License

MIT