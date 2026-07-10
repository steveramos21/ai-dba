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