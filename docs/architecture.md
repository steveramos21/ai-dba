# Architecture

## Project Structure

```
src/
  index.ts            — CLI entry (Commander)
  server.ts           — McpServer setup, tool registration
  config.ts           — config.yaml loader, URL parsing
  connector.ts        — DatabaseConnector interface + shared types
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
  types/
    oracledb.d.ts     — Type stub for oracledb
test/
  integration-all.mjs — Integration tests (5 live Docker databases)
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
  closeAllPools(): Promise<void>;
}
```

This allows the MCP tools and CLI to be completely engine-agnostic.

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
- Test URL parsers and MCP tool dispatch logic
- Use `vi.fn()` mocks — no real database connections
- 39 tests across 10 files

### Integration Tests (node test/integration-all.mjs)
- Test all 7 connector methods against live Docker databases
- 121 tests across 5 engines (MySQL, PostgreSQL, SQL Server, Oracle, MongoDB)
- **13 bugs caught** that mocks missed (6 SQL Server, 6 Oracle, 1 MongoDB)

### Lesson Learned

> Mocked unit tests verify dispatch logic but prove nothing about real SQL. Always run integration tests against live databases before merging.