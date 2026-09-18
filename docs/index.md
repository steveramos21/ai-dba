# AI-DBA

Universal database copilot — diagnostics, operations, and performance analysis via MCP and CLI.

## What is AI-DBA?

AI-DBA is an **MCP server** that exposes database diagnostics as tools for AI agents (Hermes, Claude Code, Cursor), plus a **CLI/REPL** for direct use. It supports five database engines with a single unified interface.

## Features

- **MCP Server** — expose database diagnostics as tools for AI agents
- **CLI** — one-off commands for scripting and automation
- **Interactive REPL** — explore your databases interactively with standard DBA commands
- **Connection URLs** — connect via `mysql://`, `postgresql://`, `sqlserver://`, `oracle://`, or `mongodb://` (no config file needed)
- **Database-agnostic commands** — `databases`, `tables`, `describe`, `indexes`, `processes` work across all engines
- **Multi-engine support** — MySQL, PostgreSQL, SQL Server, Oracle, MongoDB
- **Blocking chains** — detect and report row-level blocking with full query details (per engine)
- **Read-only guardrails** — query method rejects any non-SELECT statement
- **GitHub Actions CI** — build + test on Node 20/22, runs on every push/PR to main

## Supported Engines

| Engine | Driver | Port | URL Scheme |
|--------|--------|------|------------|
| MySQL 8.0 | mysql2 | 3306 | `mysql://` |
| PostgreSQL 16 | pg | 5432 | `postgresql://` |
| SQL Server 2022 | tedious | 1433 | `sqlserver://` |
| Oracle XE 21 | oracledb (thin) | 1521 | `oracle://` |
| MongoDB 7 | mongodb | 27017 | `mongodb://` |

## Quick Start

```bash
npm install
npm run build
cp config.yaml.example config.yaml
# Edit config.yaml with your database credentials
npm run repl
```

Or connect directly via URL:

```bash
node dist/index.js repl
# Then: connect mysql://root:password@127.0.0.1:3306/mydb
```

## Test Results

- **94 unit tests** (URL parsers, MCP tool dispatch, SQL guard validation)
- **~235 integration tests** against live Docker databases (121 Sprint 1-7 + 84 Sprint 8 + ~30 Sprint 9)
- **~330 total tests**, all passing
- **17 bugs** caught by integration testing (all missed by mocked unit tests)