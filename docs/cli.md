# CLI & REPL

## CLI Commands

### `serve`
Start the MCP server (stdio transport):
```bash
node dist/index.js --config config.yaml serve
```

### `repl`
Interactive REPL for exploring databases:
```bash
node dist/index.js --config config.yaml repl
```

### `connect`
Connect via URL and drop into REPL:
```bash
node dist/index.js connect mysql://root:password@127.0.0.1:3306/mydb
node dist/index.js connect postgresql://postgres@127.0.0.1:5432/mydb
node dist/index.js connect sqlserver://sa:password@127.0.0.1:1433/mydb
node dist/index.js connect oracle://user:password@127.0.0.1:1521/XEPDB1
node dist/index.js connect mongodb://user:password@127.0.0.1:27017/mydb?authSource=admin
```

### `list-engines`
List all configured engines:
```bash
node dist/index.js --config config.yaml list-engines
```
Output: Table with engine ID, type, host, port, database, URL (masked).

### `blocking-chains`
Check for blocking chains on an engine:
```bash
node dist/index.js --config config.yaml blocking-chains my-mysql
node dist/index.js --config config.yaml blocking-chains my-mysql --json
```

### `databases`
List databases on an engine:
```bash
node dist/index.js --config config.yaml databases my-mysql
```

### `tables`
List tables (optional database/schema filter):
```bash
node dist/index.js --config config.yaml tables my-mysql
node dist/index.js --config config.yaml tables my-mysql information_schema
node dist/index.js --config config.yaml tables mongodb-test testdb
```

### `describe`
Show column metadata for a table:
```bash
node dist/index.js --config config.yaml describe my-mysql blocking_test
```

### `indexes`
List indexes on a table:
```bash
node dist/index.js --config config.yaml indexes my-mysql blocking_test
```

### `processes`
Show active connections on an engine:
```bash
node dist/index.js --config config.yaml processes my-mysql
```

### `table-sizes`
List table sizes with data/index/total breakdown:
```bash
node dist/index.js --config config.yaml table-sizes my-mysql
node dist/index.js --config config.yaml table-sizes my-mysql information_schema
```
Output includes table name, rows, data size, index size, total size, and free space — all in human-readable format (B/KB/MB/GB).

### `explain`
Show execution plan for a query:
```bash
node dist/index.js --config config.yaml explain my-mysql "SELECT * FROM users WHERE id = 1"
node dist/index.js --config config.yaml explain my-postgres "SELECT * FROM users WHERE id = 1" -a
```
The `-a, --analyze` flag runs `EXPLAIN ANALYZE` (PostgreSQL executes the query; MySQL silently ignores the flag; SQL Server returns XML plan; Oracle uses EXPLAIN PLAN + DBMS_XPLAN; MongoDB uses executionStats verbosity).

For MongoDB, pass a JSON command document:
```bash
node dist/index.js --config config.yaml explain mongodb-test '{"find":"blocking_test","filter":{}}'
```

### `slow-queries`
List slow queries from engine internals:
```bash
node dist/index.js --config config.yaml slow-queries my-mysql
node dist/index.js --config config.yaml slow-queries my-mysql --limit 20 --min-duration-ms 500
```
Returns query text, execution count, total/avg/max execution time, and rows examined. Returns empty array if the feature is unavailable (e.g., `pg_stat_statements` not installed, `VIEW SERVER STATE` denied).

### `health-check`
Run a health check on an engine:
```bash
node dist/index.js --config config.yaml health-check my-mysql
```
Runs 4 checks and reports an aggregated status:

| Check | Critical (fail) | Warning (warn) |
|-------|-----------------|-----------------|
| Connectivity | Connection failed | — |
| Blocking chains | Any chain detected | — |
| Active processes | — | >50 processes |
| Slow queries | — | Any found |

### `--version`
```bash
node dist/index.js --version
```

## REPL Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `help` | `h` | Show command list |
| `engines` | `e` | List configured engines (* marks current) |
| `use <id>` | `\u` | Switch to engine |
| `databases` | `db` | List databases/schemas |
| `tables` | `dt` | List tables (optional: `tables <schema>`) |
| `describe <table>` | `desc` | Show column metadata |
| `indexes <table>` | `idx` | Show indexes |
| `processes` | `ps` | Show active connections |
| `blocking-chains` | `bc` | Show blocking chains |
| `table-sizes` | `ts` | Show table sizes (optional: `table-sizes <database>`) |
| `explain <query>` | `exp` | Show execution plan (optional: `explain <query> -a`) |
| `slow-queries` | `sq` | List slow queries (optional: `--limit N --min-ms N`) |
| `health-check` | `hc` | Run health check on current engine |
| `sql <query>` | `\s` | Run read-only query |
| `connect <url>` | `\c` | Connect to new engine via URL |
| `quit` | `q` | Exit REPL |

## Examples

```text
> engines
  ID              TYPE        HOST          PORT    DATABASE
* my-mysql        mysql       127.0.0.1     3306    mydb
  my-postgres     postgres    127.0.0.1     5432    mydb

> use my-postgres
Switched to my-postgres

> tables
  blocking_test

> describe blocking_test
  COLUMN    TYPE         NULLABLE    PRIMARY    AUTO_INCREMENT
  id        integer      false       true       true
  value     integer      true        false      false

> sql SELECT * FROM blocking_test LIMIT 3
  id    value
  1     100
  2     200
  3     300

> quit
Bye.
```