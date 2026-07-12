# Testing

## Test Summary

| Type | Count | Command |
|------|-------|---------|
| Unit tests | 75 | `npm test` |
| Integration tests (Sprints 1-7) | 121 | `npm run test:integration` |
| Integration tests (Sprint 8) | 84 | `npm run test:integration:sprint8` |
| **Total** | **280** | |

## Unit Tests

```bash
npm test
```

No Docker required. Tests URL parsers, MCP tool dispatch logic, and SQL guard validation. 75 tests across 15 files covering:

- URL parsers (`parseMysqlUrl`, `parsePostgresUrl`, `parseSqlServerUrl`, `parseOracleUrl`, `parseMongoUrl`)
- MCP tool dispatch (happy path, unknown engine, unsupported type, connector error propagation)
- SQL guard validation (destructive keyword detection with `\b` word boundaries, explain query validation, MongoDB JSON command detection)

## Integration Tests

Requires 5 Docker containers:

```bash
docker compose up -d
# Wait for all healthy
npm run test:integration       # 121 tests (Sprints 1-7)
npm run test:integration:sprint8  # 84 tests (Sprint 8)
```

Tests all 10 connector methods against live MySQL 8.0, PostgreSQL 16, SQL Server 2022, Oracle XE 21, and MongoDB 7.

### Bugs Caught by Integration Testing

| Sprint | Engine | Bugs | Example |
|--------|--------|------|---------|
| 3 | MySQL | 3 | `INNODB_LOCK_WAITS` removed in MySQL 8.0 |
| 3 | PostgreSQL | 0 | — |
| 4 | SQL Server | 6 | `connect()` never called `conn.connect()` — silent hang |
| 5 | Oracle | 6 | `user_objects` has no `OWNER` column |
| 6 | MongoDB | 1 | `_id_` index doesn't set `unique: true` |
| 8 | SQL Server | 1 | `SELECT * FROM t LIMIT 1` fails — SQL Server uses `TOP 1` |
| **Total** | | **17** | |

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
- `npm ci` → `npm run build` → `npm test` (75 unit tests)
- CLI entry point verification
- Integration tests excluded (require 5 Docker containers)