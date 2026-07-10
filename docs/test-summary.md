# Testing

## Test Summary

| Type | Count | Command |
|------|-------|---------|
| Unit tests | 39 | `npm test` |
| Integration tests | 121 | `node test/integration-all.mjs` |
| **Total** | **160** | |

## Unit Tests

```bash
npm test
```

No Docker required. Tests URL parsers (`parseMysqlUrl`, `parsePostgresUrl`, `parseSqlServerUrl`, `parseOracleUrl`, `parseMongoUrl`) and MCP tool dispatch logic (happy path, unknown engine, unsupported type, connector error propagation).

## Integration Tests

Requires 5 Docker containers:

```bash
docker compose up -d
# Wait for all healthy
node test/integration-all.mjs
```

Tests all 7 connector methods against live MySQL 8.0, PostgreSQL 16, SQL Server 2022, Oracle XE 21, and MongoDB 7.

### Bugs Caught by Integration Testing

| Sprint | Engine | Bugs | Example |
|--------|--------|------|---------|
| 3 | MySQL | 3 | `INNODB_LOCK_WAITS` removed in MySQL 8.0 |
| 3 | PostgreSQL | 0 | — |
| 4 | SQL Server | 6 | `connect()` never called `conn.connect()` — silent hang |
| 5 | Oracle | 6 | `user_objects` has no `OWNER` column |
| 6 | MongoDB | 1 | `_id_` index doesn't set `unique: true` |
| **Total** | | **13** | |

## Manual Testing

See [Testing Guide](testing-guide.md) for comprehensive per-engine manual test procedures including:

- Docker setup and seeding commands
- CLI smoke tests
- REPL walkthroughs
- Blocking scenario tests (per engine)
- MCP tool verification
- Troubleshooting guides

## CI

GitHub Actions runs on every push/PR to main:

- Node 20.x and 22.x matrix
- `npm ci` → `npm run build` → `npm test` (39 unit tests)
- CLI entry point verification
- Integration tests excluded (require 5 Docker containers)