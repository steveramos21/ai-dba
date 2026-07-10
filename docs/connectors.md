# Connectors

AI-DBA supports five database engines, each implementing the `DatabaseConnector` interface with seven methods.

## Interface

All connectors implement:

| Method | Description |
|--------|-------------|
| `listDatabases` | List databases/schemas |
| `listTables` | List tables (optional database/schema filter) |
| `describeTable` | Column metadata (name, type, nullable, PK, auto-increment) |
| `listIndexes` | Index info (name, columns, unique, primary, type) |
| `listProcesses` | Active connections/sessions |
| `query` | Read-only SQL/JSON query (rejects writes) |
| `getBlockingChains` | Blocking/lock detection |

## MySQL

**Driver:** `mysql2/promise`
**URL:** `mysql://user:password@host:port/database`

- Uses `INFORMATION_SCHEMA` for metadata
- Blocking chains via `performance_schema.data_lock_waits` (MySQL 8.0+)
- `query()` allows `SELECT`, `SHOW`, `WITH`, `EXPLAIN`, `DESCRIBE`

```yaml
my-mysql:
  type: mysql
  url: mysql://root:password@127.0.0.1:3306/mydb
```

## PostgreSQL

**Driver:** `pg`
**URL:** `postgresql://user:password@host:port/database`

- Uses `information_schema` and `pg_catalog`
- Blocking chains via `pg_blocking_pids()`
- `query()` allows `SELECT`, `WITH`, `EXPLAIN`

```yaml
my-postgres:
  type: postgres
  url: postgresql://postgres@127.0.0.1:5432/mydb
```

## SQL Server

**Driver:** `tedious` (raw driver, promise-based wrapper)
**URL:** `sqlserver://user:password@host:port/database`

- Uses `INFORMATION_SCHEMA` and `sys.dm_exec_*` DMVs
- Blocking chains via `sys.dm_os_waiting_tasks` + `sys.dm_exec_requests`
- `listProcesses` filters to user processes only (`session_id >= 50`)
- **Known limitation:** No connection pooling (new TCP connection per call)
- tedious returns JS booleans for BIT columns — connector uses `Boolean()` cast

```yaml
my-sqlserver:
  type: sqlserver
  url: sqlserver://sa:password@127.0.0.1:1433/mydb
```

## Oracle

**Driver:** `oracledb` (thin mode — no Oracle Instant Client needed)
**URL:** `oracle://user:password@host:port/service`

- Uses `user_*` and `all_*` views (no SELECT ANY DICTIONARY needed for metadata)
- `listProcesses` and `getBlockingChains` use `v$session` — requires SELECT ANY DICTIONARY
- **Graceful fallback:** Returns empty arrays if `v$` access denied (ORA-00942/ORA-01031)
- Oracle uppercases identifiers by default
- Bind variable names use `:tbl` (not `:table` — reserved in oracledb)

```yaml
my-oracle:
  type: oracle
  url: oracle://user:password@127.0.0.1:1521/XEPDB1
```

!!! note "SELECT ANY DICTIONARY"
    To see active processes and blocking chains, grant:
    ```sql
    GRANT SELECT ANY DICTIONARY TO myuser;
    ```

## MongoDB

**Driver:** `mongodb` (official Node.js driver, ESM-native)
**URL:** `mongodb://user:password@host:port/database?authSource=admin`

- `listTables` lists collections
- `describeTable` infers schema by sampling up to 100 documents
- `listProcesses` uses `db.currentOp()`
- `query()` accepts **JSON command documents** (not SQL): `find`, `aggregate`, `count`, `distinct`, `ping`
- `getBlockingChains` reports long-running operations (MongoDB has no traditional row locks)

```yaml
my-mongo:
  type: mongodb
  url: mongodb://user:password@127.0.0.1:27017/mydb?authSource=admin
```

!!! warning "Query API difference"
    MongoDB `query()` takes JSON, not SQL:
    ```json
    {"find": "my_collection", "filter": {}, "limit": 10}
    ```

## Capabilities Matrix

| Feature | MySQL | PostgreSQL | SQL Server | Oracle | MongoDB |
|---------|-------|------------|------------|--------|---------|
| listDatabases | Schemas | Databases | Databases | Users | Databases |
| listTables | Tables | Tables | Tables | Tables | Collections |
| describeTable | Columns | Columns | Columns | Columns | Inferred fields |
| listIndexes | Indexes | Indexes | Indexes | Indexes | Indexes |
| listProcesses | processlist | pg_stat_activity | dm_exec_sessions | v$session* | currentOp |
| query | SQL | SQL | SQL | SQL | JSON commands |
| getBlockingChains | Lock waits | pg_blocking_pids | dm_os_waiting_tasks | v$session* | Long ops |
| Connection pooling | Yes (mysql2) | Yes (pg.Pool) | No (per-call) | Yes (oracledb pool) | Yes (MongoClient) |

*Requires SELECT ANY DICTIONARY privilege.