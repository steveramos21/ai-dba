# AI-DBA Sprint Plan

## Project Overview

**Goal**: Universal database copilot — reduce diagnosis time from 30-60 min to <30 sec with rollback-first philosophy.

**Tech Stack**: Node.js/TypeScript, mysql2/pg/tedious/oracledb/mongodb drivers, Commander+Inquirer (CLI), Vitest (testing), YAML config, MCP SDK

**Repo**: https://github.com/steveramos21/ai-dba
**Local**: /mnt/d/ai-dba
**Discord**: #ai-dba

---

## Sprint 1 — Blocking Chains Diagnostics (COMPLETE)

**Status**: DONE. Merged via PRs #1, #2, #3, #4.

### What was built:
- MCP server with `blocking_chains` tool for MySQL
- CLI: `blocking-chains <engineId>`, `list-engines`, `connect <url>`
- REPL: `databases`, `tables`, `describe`, `indexes`, `processes`, `sql`, `status`, `connect`, `blocking-chains` + aliases
- Database-agnostic `DatabaseConnector` interface
- MySQL connector implementing full connector interface
- Connection URL support (mysql://user:***@host:port/db?ssl=true)
- `npm run connect` drops into REPL
- Configurable via YAML or URL
- CodeGraph indexed

### Sprint 1 Retro:
- MySQL blocking chains — working, tested against Docker MySQL 8
- PostgreSQL, SQL Server, Oracle, MongoDB — NOT YET (only MySQL connector exists)
- `connect` command had auth bug (URL password parsing) — resolved
- PRs: squash-merge, one per feature batch

---

## Sprint 2 — PostgreSQL Connector + Blocking Chains (COMPLETE)

**Status**: DONE. Merged via PRs #5, #7, #8, #9.

### What was built:
- PostgreSQL connector implementing full `DatabaseConnector` interface
- `pg` driver with connection string pass-through to `pg.Pool`
- Docker PostgreSQL 16 on port 15432 alongside MySQL
- `getBlockingChains()` added to `DatabaseConnector` interface as a class method
- `BlockingChain` type consolidated into `connector.ts` (12 nullable fields, replaces `BlockingChainInfo`)
- `types.ts` deleted — all shared types in `connector.ts`
- MySQL blocking chains query fixed (3 bugs: wrong PIDs, wrong database_name, wrong wait_event)
- PostgreSQL blocking chains implementation (`pg_blocking_pids()` + `pg_stat_activity`, `query_start` for duration)
- Engine-agnostic dispatch via connector map — MCP tool, CLI, REPL all use `connectors[engine.type]`
- Centralized `shutdown(connectors)` iterates all connectors for pool cleanup
- Unit tests for both MySQL and PostgreSQL `getBlockingChains()` with mocked rows
- PostgreSQL integration test (`LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` scenario)
- All stale branches deleted, `AGENTS.md` committed, `.claude/` gitignored

### PRs:
- PR #5 — PostgreSQL connector (Sprint 2 base)
- PR #7 — Interface refactor: `getBlockingChains()` on interface, types consolidation, connector map dispatch
- PR #8 — Fix MySQL blocking chains query (4-join: INNODB_LOCK_WAITS + INNODB_TRX x2 + threads x2)
- PR #9 — PostgreSQL blocking chains implementation + integration test + docs

### Sprint 2 Retro:
- PostgreSQL connector — working, tested against Docker PostgreSQL 16
- Blocking chains — now engine-agnostic, both MySQL and PostgreSQL supported
- Connector map pattern — clean dispatch, no hardcoded engine guards
- Integration test catches real blocking scenarios — verified correct PID separation and field mapping
- PR sequence worked well: interface refactor first (PR 1), then query fix (PR 2), then impl + docs (PR 3)

### Lessons Learned:
- **MySQL field mapping bug was invisible without value-asserting tests**: The original MySQL query had `blocking_pid` and `blocked_pid` both from the same column, but the integration test only checked `chains.length > 0` — it passed because a chain was "detected" even though the PIDs were identical. The unit test added in PR 2 asserts specific field values, which would have caught the bug immediately. Lesson: presence-based tests are insufficient for field mapping correctness — assert actual values.
- **Standalone-to-interface refactor pattern**: Moving a standalone function (`getBlockingChainsMySQL`) into a class method on an interface required touching 3 entry points (MCP tool, CLI, REPL) simultaneously. The stub-first approach (PR 1 moves the broken query unchanged, PR 2 fixes it) kept the refactor PR clean and the fix PR small — good separation of concerns.
- **`pg_blocking_pids()` returns `integer[]`**: The initial query used `JOIN LATERAL pg_blocking_pids(blocked.pid) AS block_pid ON true` which failed with `operator does not exist: integer = integer[]`. Fixed by wrapping in `unnest()` — `JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS block_pid ON true`. The integration test caught this before the unit test could, because the mock didn't exercise the actual SQL type system.

---

## Development Workflow (Locked from Grill Session)

### Branch Naming
- `feature/<engine>-<feature>` (e.g., `feature/postgres-connector`)
- `bugfix/<short-description>` (e.g., `bugfix/connect-auth`)

### PR Process
- Feature branch per task → PR → review → squash-and-merge
- PR template: Summary, Details (queries, mapping), Testing, Checklist (CodeGraph sync, lint, tests pass)
- Minimum 1 approval + all CI checks pass
- Labels: `engine:<name>`, `type:feature`/`type:bugfix`, `sprint:<N>`

### Merge Strategy
- Squash-and-merge to keep `main` history clean

### Testing
- Unit tests with Vitest (connector mapping, config parsing)
- Integration tests against Docker containers
- Each sprint includes testing + retro

### Communication
- Discord #ai-dba for progress logging
- GitHub PRs for code review

### CodeGraph
- Run `codegraph sync` after each feature
- Git hooks auto-sync (post-commit, post-merge, post-checkout)
- Weekly upgrade cron (Monday 9am)

---

## Architecture (Current State)

```
src/
  index.ts          — CLI entry (Commander + REPL)
  config.ts         — YAML config + URL parsing + resolveMysqlConfig
  connector.ts      — DatabaseConnector interface + BlockingChain type (engine-agnostic)
  connectors/
    mysql.ts         — MySQL connector (DatabaseConnector impl)
    postgres.ts       — PostgreSQL connector (DatabaseConnector impl)
  server.ts         — MCP server + connector map + shutdown
  tools/
    blocking-chains.ts — MCP tool (connector map dispatch)
```

### DatabaseConnector Interface
```typescript
interface DatabaseConnector {
  listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]>
  listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]>
  describeTable(engineId: string, config: EngineConfig, table: string, database?: string): Promise<ColumnInfo[]>
  listIndexes(engineId: string, config: EngineConfig, table: string): Promise<IndexInfo[]>
  listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]>
  query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult>
  getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]>
  closeAllPools(): Promise<void>
}
```

### npm Scripts
```
npm run build       — tsc compile
npm run repl        — start REPL with config
npm run connect     — connect via URL, drop into REPL
npm run serve        — start MCP server
npm run dev         — tsx watch dev mode
npm test            — run Vitest tests
```

---

## Sprint 3 — MCP DBA Tools + CI (COMPLETE)

**Status**: DONE.

### What was built:
- 5 new MCP tools: `databases`, `tables`, `describe-table`, `indexes`, `processes` — all engine-agnostic via connector map dispatch
- All tools support optional `database` parameter to override configured database (MySQL) or schema (PostgreSQL)
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) — Node 20/22 matrix, build + unit tests on every push/PR to main. **Note:** CI file is ready but couldn't be pushed due to PAT lacking `workflow` scope — user must add via GitHub UI or workflow-scoped token.
- 20 new unit tests (5 tools × 4 tests each) — happy path, unknown engine, unsupported type, connector error propagation
- Fixed MySQL connector `listTables`/`describeTable`/`listIndexes` to accept `database` param and fall back to URL-parsed database for URL-only configs
- Fixed PostgreSQL connector `listTables`/`describeTable`/`listIndexes` to accept `database` param as schema override
- Fixed `list-engines` CLI and REPL `engines` command — no longer calls `parseMysqlUrl` on PostgreSQL URLs (was crashing on non-MySQL URLs)
- Pinned `zod` as explicit dependency (was transitive via MCP SDK)
- Changed `npm test` to `vitest run` (was watch mode — would hang CI)

### Test coverage:
- Connector tests: 7 (MySQL 3 + PostgreSQL 4)
- MCP tool tests: 20 (5 tools × 4 tests each)
- Total: 27 tests across 7 test files

### PR:
- PR #10 — Sprint 3: MCP DBA tools + CI

### Sprint 3 Retro:
- Integration testing against live Docker databases caught 3 critical bugs that 27 mocked unit tests missed:
  1. `listProcesses` — `database` is a MySQL reserved word, needed backticks
  2. `getBlockingChains` — used `INNODB_LOCK_WAITS` (removed in MySQL 8.0) → rewrote with `performance_schema.data_lock_waits`
  3. Wrong join key (`THREAD_ID` vs `PROCESSLIST_ID`) + NULL `blocking_query` → fixed with COALESCE + `events_statements_current` fallback
- Lesson: mocked unit tests verify dispatch logic but prove nothing about real SQL. Always run integration tests against live databases before merging.
- Test results: 27 unit + 49 integration + 21 live blocking = 97 tests, all passing

---

## Sprint 4 — SQL Server Connector (COMPLETED)

### What was built:
- `tedious` driver with promise-based wrapper (`TediousConnection` class)
- All 7 connector methods: listDatabases, listTables, describeTable, listIndexes, listProcesses, query, getBlockingChains
- Docker SQL Server 2022 container (port 11433, Express edition)
- `sqlserver://` URL scheme support in CLI + REPL
- 4 new unit tests (`parseSqlServerUrl` — extraction, defaults, URL-encoding, invalid)
- 24 new integration tests against live SQL Server 2022

### Sprint 4 Retro:
- Integration testing caught 6 bugs that mocked tests missed:
  1. `connect()` never called `this.conn.connect()` — silent hang on first query
  2. `isPrimary`/`isUnique` — tedious returns JS booleans, not 0/1 (BIT columns)
  3. `isAutoIncrement` — same BIT boolean issue, fixed with `Boolean()`
  4. `listProcesses` — returned 70+ system processes, filtered to user processes only (`session_id >= 50 AND is_user_process = 1`)
  5. `listTables` — `TABLE_CATALOG` vs `TABLE_SCHEMA` for database/schema filter
  6. `Request` event types — tedious `.d.ts` doesn't expose `columnMetadata`/`row` as typed events, cast through `any`
- Known limitations: no connection pooling (each call creates new TCP connection), SQL Server blocking scenario not automated in integration-blocking.mjs (documented in TESTING.md for manual verification)
- Test results: 31 unit + 72 integration = 103 tests, all passing

---

## Sprint 5 — Oracle Connector (COMPLETED)

### What was built:
- `oracledb` thin mode (no Oracle Instant Client needed)
- All 7 connector methods: listDatabases, listTables, describeTable, listIndexes, listProcesses, query, getBlockingChains
- Docker Oracle XE 21 container (port 11521, gvenzl/oracle-xe:21-slim)
- `oracle://` URL scheme support in CLI + REPL
- 4 new unit tests (`parseOracleUrl` — extraction, defaults, URL-encoding, invalid)
- 24 new integration tests against live Oracle XE 21
- Graceful `v$` permission fallback — `listProcesses`/`getBlockingChains` return empty arrays if user lacks SELECT ANY DICTIONARY

### Sprint 5 Retro:
- Integration testing caught 6 bugs that mocked tests missed:
  1. `user_objects` has no `OWNER` column → fixed with `USER AS schema`
  2. `:table` is a reserved bind variable in oracledb → renamed to `:tbl`
  3. Column aliases (`AS name`) conflict with bind variables → removed them, use positional indexing
  4. Oracle requires `FROM DUAL` for bare SELECT → handled in test assertions
  5. Oracle uppercases identifiers by default → test assertions handle both `ID`/`id`, `VAL`/`val`
  6. `v$session` requires SELECT ANY DICTIONARY → graceful fallback to empty array on ORA-00942/ORA-01031
- Known limitations: `listProcesses`/`getBlockingChains` return empty without SELECT ANY DICTIONARY privilege; Oracle blocking scenario documented in TESTING.md for manual verification; no connection pooling
- Test results: 35 unit + 96 integration = 131 tests, all passing

---

## Sprint 6 — MongoDB Connector (COMPLETED)

### What was built:
- `mongodb` driver (ESM-native, no type stubs needed)
- All 7 connector methods: listDatabases, listTables (collections), describeTable (schema inference), listIndexes, listProcesses (currentOp), query (JSON command documents), getBlockingChains (long-running ops)
- Docker MongoDB 7 container (port 12017, mongo:7 with auth)
- `mongodb://` and `mongodb+srv://` URL scheme support in CLI + REPL
- 4 new unit tests (`parseMongoUrl` — extraction, defaults, srv scheme, invalid)
- 24 new integration tests against live MongoDB 7
- `query()` accepts JSON command documents (find, aggregate, count, distinct, ping) with read-only guard

### Sprint 6 Retro:
- Integration testing caught 1 bug that mocked tests missed:
  1. MongoDB `_id_` index doesn't set `unique: true` in `listIndexes()` result — fixed by checking `idx.name === "_id_"` as fallback for uniqueness
- Known limitations: schema inference is sampled (100 docs), not authoritative; `currentOp` requires appropriate privileges; `query()` uses JSON command documents instead of SQL (documented API difference)
- Test results: 39 unit + 121 integration = 160 tests, all passing

---

## Sprint 7 — Documentation Site (COMPLETED)

### What was built:
- MkDocs Material site with 8 pages: index, getting-started, connectors, cli, mcp, architecture, testing-guide, test-summary
- Light/dark mode toggle, code copy buttons, search, tabbed navigation
- `mkdocs.yml` config with nav, theme, markdown extensions
- `docs/TESTING.md` renamed to `docs/testing-guide.md` (MkDocs case sensitivity)
- `docs/index.html` removed (conflicted with `index.md`)
- `.venv/` and `site/` added to `.gitignore`
- Build passes `--strict` (0 warnings, 0 errors)

### Sprint 7 Retro:
- MkDocs Material 9.7.6 on Python 3.12 (venv at `.venv/`)
- 3 anchor link mismatches in testing-guide.md (em-dash vs hyphen) — fixed
- Material for MkDocs deprecation warning (MkDocs 2.0 future notice) — informational only, not a blocker

---

## Sprint 8 — Query Performance & Health (COMPLETE)

**Goal**: Move from passive inspection to active diagnostics — explain plans, slow queries, table sizes, and health checks.

### Completed Items

#### table-sizes (COMPLETE)
- `TableSizeInfo` type in `connector.ts` — `name`, `rows`, `dataSizeBytes`, `indexSizeBytes`, `totalSizeBytes`, `dataFreeBytes`, `comment`
- `listTableSizes()` method on `DatabaseConnector` interface
- All 5 connectors implemented:
  - MySQL: `INFORMATION_SCHEMA.TABLES` (DATA_LENGTH + INDEX_LENGTH + DATA_FREE)
  - PostgreSQL: `pg_relation_size` + `pg_indexes_size` + `pg_total_relation_size`
  - SQL Server: `sys.allocation_units` + `sys.partitions` (with identifier validation)
  - Oracle: `user_segments`/`all_segments` (TABLE + INDEX segments grouped)
  - MongoDB: `collStats` command per collection
- MCP tool `table-sizes` with optional `database` parameter
- CLI: `table-sizes <engineId> [database]`
- REPL: `table-sizes` command with alias `ts`
- `formatBytes()` helper for human-readable size display
- 4 unit tests (happy path, database param, unknown engine, error propagation)

#### explain (COMPLETE)
- `ExplainResult` type in `connector.ts` — `plan`, `format` (json/text/xml), `estimatedCost`, `estimatedRows`, `analyzed`
- `ExplainOptions` type — `analyze` flag (PostgreSQL EXPLAIN ANALYZE)
- `explainQuery()` method on `DatabaseConnector` interface
- All 5 connectors implemented:
  - MySQL: `EXPLAIN FORMAT=JSON` (analyze flag silently ignored — MySQL doesn't support EXPLAIN ANALYZE)
  - PostgreSQL: `EXPLAIN (FORMAT JSON[, ANALYZE, BUFFERS])` — analyze flag actually executes the query
  - SQL Server: `SET SHOWPLAN_XML ON` → run query → `SET SHOWPLAN_XML OFF` (returns XML plan)
  - Oracle: `EXPLAIN PLAN SET STATEMENT_ID = ...` + `DBMS_XPLAN.DISPLAY()` + cleanup (unique statement ID per call for concurrency safety)
  - MongoDB: `explain` command with `queryPlanner` or `executionStats` verbosity
- `sql-guard.ts` shared validation module:
  - `validateReadOnlySql()` — guards REPL `sql` command (replaces inline connector guards)
  - `validateExplainQuery()` — stricter guard for explain (SELECT/WITH only, destructive keyword scan with `\b` word boundaries)
  - `isJsonCommand()` — detects MongoDB JSON command documents
- MCP tool `explain` with `analyze` parameter — validates input before calling connector
- CLI: `explain <engineId> <query>` with `-a, --analyze` flag
- REPL: `explain` command with alias `exp`
- 20 sql-guard tests + 4 explain tool tests

### Remaining Items

_None — all Sprint 8 features are complete._

#### slow-queries (COMPLETE)
- `SlowQueryInfo` type in `connector.ts` — `id`, `query`, `database`, `executionCount`, `totalExecutionTimeMs`, `avgExecutionTimeMs`, `maxExecutionTimeMs`, `rowsExamined`, `rowsReturned`, `firstSeen`, `lastSeen`
- `SlowQueryOptions` type — `limit`, `minDurationMs`
- `listSlowQueries()` method on `DatabaseConnector` interface
- All 5 connectors implemented (all time units normalized to milliseconds):
  - MySQL: `performance_schema.events_statements_summary_by_digest` (picoseconds ÷ 1,000,000,000 → ms). Graceful empty on `performance_schema` disabled or access denied.
  - PostgreSQL: `pg_stat_statements` (already in ms). Graceful empty if extension not installed (`42P01`) or permission denied (`42501`).
  - SQL Server: `sys.dm_exec_query_stats` + `sys.dm_exec_sql_text` (microseconds ÷ 1,000 → ms). `NULLIF(execution_count, 0)` guard. Graceful empty if `VIEW SERVER STATE` denied.
  - Oracle: `V$SQLAREA` (microseconds ÷ 1,000 → ms). Positional binds (`:1`, `:2`) for oracledb compatibility. Graceful empty on `ORA-00942` / `ORA-01031`.
  - MongoDB: `currentOp` with `secs_running` filter — shows currently running ops only (fundamental MongoDB limitation; no historical slow query log).
- `formatDuration()` helper for human-readable time display in CLI/REPL
- MCP tool `slow-queries` with `limit` and `minDurationMs` parameters
- CLI: `slow-queries <engineId>` with `--limit` and `--min-duration-ms` flags
- REPL: `slow-queries` command with alias `sq`
- 4 unit tests (happy path, options passthrough, unknown engine, error propagation)

#### health-check (COMPLETE)
- `HealthCheck` type in `connector.ts` — `name`, `status` (pass/warn/fail/skip), `message`, `value`
- `HealthCheckResult` type — `status` (healthy/warning/critical), `engineId`, `engineType`, `checks[]`, `timestamp`
- **No new connector method** — pure tool-level orchestration reusing existing `query()`, `getBlockingChains()`, `listProcesses()`, `listSlowQueries()` methods
- 4 checks per engine:
  1. **Connectivity** — `SELECT 1` (or `SELECT 1 FROM DUAL` for Oracle, `{ping: 1}` for MongoDB). Fail = critical.
  2. **Blocking chains** — reuses `getBlockingChains()`. Any chains = critical.
  3. **Active processes** — reuses `listProcesses()`. >50 processes = warning.
  4. **Slow queries** — reuses `listSlowQueries()` with `limit: 5, minDurationMs: 1000`. Any found = warning.
- Aggregation: any `fail` → critical; any `warn` → warning; all `pass` → healthy. `skip` doesn't affect status.
- MCP tool `health-check` with `engineId` parameter
- CLI: `health-check <engineId>` with color-coded status table
- REPL: `health-check` command with alias `hc`
- 4 unit tests (all pass, blocking = critical, slow queries = warning, unknown engine)

### Final Test Results
- **75 unit tests** across **15 test files**, all passing
- Build clean (`tsc` no errors)
- 10 MCP tools registered: `blocking-chains`, `databases`, `tables`, `describe-table`, `indexes`, `processes`, `table-sizes`, `explain`, `slow-queries`, `health-check`
- 10 CLI commands, 10 REPL commands (with aliases: `bc`, `ls`, `db`, `dt`, `desc`, `idx`, `ps`, `ts`, `exp`, `sq`, `hc`)

### Bugs Fixed During Implementation
- **MySQL time units**: `performance_schema` timers are picoseconds — fixed divisor from 1,000,000 to 1,000,000,000
- **Oracle bind variables**: named binds (`:owner`, `:minUs`, `:maxRows`) → positional (`:1`, `:2`) for oracledb driver compatibility
- **SQL Server divide-by-zero**: `NULLIF(qs.execution_count, 0)` guard on avg time calculation
- **SQL Server identifier validation**: regex check before string interpolation to prevent injection
- **MongoDB `explainQuery`**: restored accidentally deleted `try {` block
- **sql-guard word boundaries**: `\\b` regex instead of space-delimited matching — catches `DELETE FROM x` embedded in SELECT clauses