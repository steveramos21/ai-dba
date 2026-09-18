# Architecture

## Project Structure

```
src/
  index.ts            — CLI entry (Commander)
  server.ts           — McpServer setup, tool registration
  config.ts           — config.yaml loader, URL parsing
  connector.ts        — DatabaseConnector interface + shared types
  sql-guard.ts        — Shared SQL validation (validateReadOnlySql, validateExplainQuery, isJsonCommand)
  connectors/
    mysql.ts          — MySQL connector (mysql2/promise)
    postgres.ts       — PostgreSQL connector (pg)
    sqlserver.ts      — SQL Server connector (tedious)
    oracle.ts          — Oracle connector (oracledb thin mode)
    mongodb.ts         — MongoDB connector (mongodb driver)
  tools/
    databases.ts      — MCP tool: list databases
    tables.ts          — MCP tool: list tables
    describe-table.ts  — MCP tool: describe table
    indexes.ts         — MCP tool: list indexes
    processes.ts       — MCP tool: list processes
    blocking-chains.ts — MCP tool: blocking chains
    table-sizes.ts     — MCP tool: table size breakdown
    explain.ts         — MCP tool: execution plans
    slow-queries.ts    — MCP tool: slow query analysis
    health-check.ts    — MCP tool: orchestrated health check
  types/
    oracledb.d.ts     — Type stub for oracledb
test/
  integration-all.mjs     — Integration tests (Sprints 1-7, 5 live Docker databases)
  integration-sprint8.mjs  — Integration tests (Sprint 8 features)
  integration-blocking.mjs — Live blocking scenario tests
```

## Key Design Decisions

### Connector Interface

All connectors implement the same `DatabaseConnector` interface:

```typescript
interface DatabaseConnector {
  listDatabases(engineId, config): Promise<DatabaseInfo[]>;
  listTables(engineId, config, database?): Promise<TableInfo[]>;
  describeTable(engineId, config, table, database?): Promise<ColumnInfo[]>;
  listIndexes(engineId, config, table, database?): Promise<IndexInfo[]>;
  listProcesses(engineId, config): Promise<ProcessInfo[]>;
  query(engineId, config, sql): Promise<QueryResult>;
  getBlockingChains(engineId, config): Promise<BlockingChain[]>;
  listTableSizes(engineId, config, database?): Promise<TableSizeInfo[]>;
  explainQuery(engineId, config, query, options?): Promise<ExplainResult>;
  listSlowQueries(engineId, config, options?): Promise<SlowQueryInfo[]>;
  closeAllPools(): Promise<void>;
}
```

This allows the MCP tools and CLI to be completely engine-agnostic.

### SQL Guard

`sql-guard.ts` provides shared validation used by CLI, REPL, and MCP tool paths:

- `validateReadOnlySql(sql)` — rejects destructive SQL (INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, MERGE, GRANT, REVOKE) using `\b` word-boundary regex
- `validateExplainQuery(engineType, query, analyze)` — validates input before EXPLAIN (SELECT/WITH only for SQL, JSON command for MongoDB)
- `isJsonCommand(query)` — detects MongoDB JSON command documents

### Graceful Degradation

`listSlowQueries` and `explainQuery` return empty results when engine features are unavailable rather than throwing:

- PostgreSQL: `pg_stat_statements` not installed → empty array
- SQL Server: `VIEW SERVER STATE` denied → empty array
- Oracle: `V$SQLAREA` access denied (ORA-00942/ORA-01031) → empty array

### ESM Convention

This is a `"type": "module"` project with `moduleResolution: nodenext`. All relative imports use `.js` extensions even when importing `.ts` source files:

```typescript
// CORRECT
import { mysqlConnector } from "./connectors/mysql.js";
// WRONG — will fail at runtime
import { mysqlConnector } from "./connectors/mysql";
```

### Connection Pooling

- MySQL: `mysql2/promise` pool
- PostgreSQL: `pg.Pool`
- SQL Server: No pool (new TCP per call — known limitation)
- Oracle: `oracledb.createPool()`
- MongoDB: `MongoClient` (internal pool)

### Read-Only Guard

Each connector's `query()` method checks the SQL/command type before executing. Write operations are rejected with an error message. This is a safety guard, not a security boundary.

## Testing Strategy

### Unit Tests (vitest)
- Test URL parsers, MCP tool dispatch logic, and SQL guard validation
- Use `vi.fn()` mocks — no real database connections
- 94 tests across 19 files

### Integration Tests
- `integration-all.mjs`: 121 tests covering 7 connector methods (Sprints 1-7)
- `integration-sprint8.mjs`: 84 tests covering table-sizes, explain, slow-queries, health-check (Sprint 8)
- 205 tests total across 5 engines (MySQL, PostgreSQL, SQL Server, Oracle, MongoDB)
- **17 bugs caught** that mocks missed (6 SQL Server, 6 Oracle, 1 MongoDB, 3 MySQL, 1 SQL Server Sprint 8)

### Lesson Learned

> Mocked unit tests verify dispatch logic but prove nothing about real SQL. Always run integration tests against live databases before merging.