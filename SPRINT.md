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

## Sprint 2 — PostgreSQL Connector (IN PROGRESS)

### Locked Decisions

| Decision | Choice |
|---|---|
| Focus | PostgreSQL connector only |
| Driver | `pg` (node-postgres) |
| URL handling | Pass connection strings directly to `pg.Pool({ connectionString })` |
| Config | URL only — no custom `resolvePostgresConfig` parsing |
| Password masking | Simple regex on display output (`url.replace(/:.*@/, ':***@')`) |
| Multi-engine | Auto-detect from URL scheme, `--type` override available |
| Docker | Add PostgreSQL to existing docker-compose on port 15432 |
| SSL | Pass-through — `pg` handles all SSL params natively |
| Testing | Vitest, mock the `pg` driver |
| Sprint scope | PostgreSQL connector only (no MCP tools) |

### Tasks (one PR each)

1. **`feature/postgres-connector`** — PostgreSQL connector implementation ✅
   - `src/connectors/postgres.ts` implementing `DatabaseConnector`
   - `pg` driver dependency
   - Connection string pass-through to `pg.Pool`
   - `listDatabases`, `listTables`, `describeTable`, `listIndexes`, `listProcesses`, `query`, `closeAllPools`
   - URL scheme detection (`postgresql://`, `postgres://`) with password masking
   - `--type` override flag on `connect` command
   - Engine-aware `status` command (MySQL vs PostgreSQL display)

2. **`feature/postgres-docker`** — Docker PostgreSQL test container ✅
   - `docker-compose.yml` with MySQL 8.0 + PostgreSQL 16
   - PostgreSQL on port 15432, MySQL on port 13306
   - Updated `config.yaml.example` with both engines

3. **`feature/postgres-tests`** — Vitest unit tests ✅
   - 13 tests, all passing
   - Mock `pg` driver, test connector methods, URL masking, error handling

4. **`bugfix/connect-auth`** — Fix `connect` URL auth bug (if time permits)
   - Deferred — not blocking

5. **`feature/mcp-dba-tools`** — Deferred to Sprint 3
- MCP DBA tools (databases, tables, describe, indexes, processes)
- Test suite + CI/CD (GitHub Actions)
- Additional diagnostic categories (slow-queries, explain, replication-status, table-stats)

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
  connector.ts      — DatabaseConnector interface (engine-agnostic)
  connectors/
    mysql.ts         — MySQL connector (DatabaseConnector impl)
    postgres.ts       — PostgreSQL connector (DatabaseConnector impl)
  server.ts         — MCP server (blocking_chains tool only)
  types.ts          — BlockingChain type + shared types
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

## Planned Sprints

### Sprint 3 — MCP DBA Tools + CI
- Expose `databases`, `tables`, `describe_table`, `indexes`, `processes` as MCP tools
- Vitest test suite
- GitHub Actions CI/CD

### Sprint 4 — SQL Server Connector
- `tedious` driver
- `sys.dm_exec_requests` + `sys.dm_os_waiting_tasks` for blocking chains
- Docker SQL Server container

### Sprint 5 — Oracle Connector
- `oracledb` driver
- `v$session` + `v$session_wait` for blocking chains
- Docker Oracle XE container

### Sprint 6 — MongoDB Connector
- `mongodb` driver
- `db.currentOp()` for blocking/long-running ops
- Docker MongoDB container

### Sprint 7 — Documentation Site
- Docusaurus or MkDocs
- Getting started, CLI reference, MCP integration guide, connector docs
- TSDoc/JSDoc for API reference generation