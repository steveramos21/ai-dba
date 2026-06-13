# AI-DBA

Universal database copilot — diagnostics, operations, and performance analysis via MCP and CLI.

## Features

- **MCP Server** — expose database diagnostics as tools for AI agents (Hermes, Claude Code, etc.)
- **CLI** — one-off commands for scripting and automation
- **Interactive REPL** — explore your databases interactively
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

### 3. Configure

Copy the example config and edit with your database credentials:

```bash
cp config.yaml.example config.yaml
```

```yaml
engines:
  mysql-primary:
    type: mysql
    host: 127.0.0.1
    port: 3306
    user: root
    password: yourpassword
    database: yourdb
```

### 4. Run

```bash
# List configured engines
node dist/index.js --config config.yaml list-engines

# Check blocking chains
node dist/index.js --config config.yaml blocking-chains mysql-primary

# Interactive REPL
node dist/index.js --config config.yaml repl

# MCP server (for AI agents)
node dist/index.js --config config.yaml serve
```

## Commands

| Command | Description |
|---------|-------------|
| `serve` | Start MCP server over stdio (for AI agents) |
| `list-engines` | List configured database engines |
| `blocking-chains <engineId>` | Show current blocking chains |
| `repl` | Interactive REPL for database diagnostics |

### Global Options

| Option | Description | Default |
|--------|-------------|---------|
| `-c, --config <path>` | Path to config.yaml | `config.yaml` |
| `-V, --version` | Show version | — |
| `-h, --help` | Show help | — |

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
ai-dba repl
```

Interactive commands:

| Command | Alias | Description |
|---------|-------|-------------|
| `help` | | Show available commands |
| `engines` | `ls` | List configured engines (current marked with *) |
| `use <engineId>` | | Switch to a different engine |
| `blocking-chains` | `bc` | Show blocking chains on current engine |
| `quit` | `q`, `exit` | Exit the REPL |

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

Expected output: a table showing the blocking chain, then JSON output, then cleanup.

### Stop MySQL

```bash
docker compose down
```

Add `-v` to also delete the data volume.

## Configuration

`config.yaml` format:

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
    host: prod-db.internal
    port: 3306
    user: readonly
    password: ${MYSQL_PROD_PASSWORD}
    database: app_db
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
  index.ts              CLI entry point (commander)
  server.ts             MCP server setup
  config.ts             YAML config loader
  types.ts              Shared TypeScript types
  connectors/
    mysql.ts            MySQL connection pool + blocking-chains query
  tools/
    blocking-chains.ts  MCP tool definition + handler
```

- **Lazy imports** — MCP SDK and mysql2 are loaded dynamically only when needed. CLI commands like `list-engines` start instantly without loading database drivers.
- **Lazy connection pools** — MySQL connections are created on first use, not at startup.
- **One tool per file** — `src/tools/blocking-chains.ts` is self-contained (schema + handler). Adding a new tool means adding a new file and registering it in `server.ts`.

## Requirements

- Node.js 18+
- MySQL 8.0+ (with `performance_schema` enabled, which is the default)

## License

MIT