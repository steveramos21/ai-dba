# AI-DBA Agent Instructions

AI-DBA is a universal database diagnostics copilot — an **MCP server** that exposes database tools to AI agents, plus a **CLI/REPL** for direct use. See [README.md](README.md) for feature overview and [SPRINT.md](SPRINT.md) for current sprint tasks and locked decisions.

## Architecture

```
src/index.ts        — CLI entry (Commander); commands: serve, repl, connect, list-engines, blocking-chains
src/server.ts       — McpServer setup; registers all MCP tools; handles graceful shutdown (SIGINT/SIGTERM → closeAllPools)
src/config.ts       — Loads config.yaml via js-yaml; parseMysqlUrl() for MySQL URLs
src/connector.ts    — DatabaseConnector interface + shared types (QueryResult, BlockingChainInfo)
src/connectors/     — Per-engine implementations: mysql.ts (mysql2/promise), postgres.ts (pg)
src/tools/          — MCP tool registrations; each tool calls a connector method
```

## Build & Test

```bash
npm install          # Install dependencies
npm run build        # tsc → dist/
npm test             # vitest (unit tests, no config file needed)
docker compose up -d # Spin up MySQL 13306 + PostgreSQL 15432 for integration tests
```

## Critical ESM Convention

This is a **`"type": "module"`** project with `"moduleResolution": "nodenext"`. **All relative imports must use `.js` extensions**, even when importing `.ts` source files:

```ts
// CORRECT
import { mysqlConnector } from "./connectors/mysql.js";
// WRONG — will fail at runtime
import { mysqlConnector } from "./connectors/mysql";
```

## Adding a New Connector

1. Create `src/connectors/<engine>.ts` implementing the `DatabaseConnector` interface from `src/connector.ts`
2. Use a `Map<string, Pool>` keyed by `engineId` for connection pooling (see `mysql.ts` or `postgres.ts`)
3. Export a module-level singleton (e.g., `export const myConnector = new MyConnector()`)
4. `query()` must enforce read-only: reject any SQL that doesn't start with `SELECT`
5. Add the engine `type` key to `config.ts` and wire it into `src/index.ts` (connect URL scheme detection)
6. Add the pool's `closeAllPools` to the shutdown chain in `src/server.ts`

## Adding a New MCP Tool

```ts
// In src/tools/<name>.ts
server.tool(
  "tool-name",
  "Description shown to AI agents",
  { engineId: z.string() },          // Zod schema for input
  async ({ engineId }) => {
    // ... call connector method
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
    // On error:
    return { content: [{ type: "text", text: "Error: ..." }], isError: true };
  }
);
```

Register the tool in `src/server.ts` and export `closeAllPools` if needed.

## Config System

Engines are configured in `config.yaml` (copy from `config.yaml.example`):

```yaml
engines:
  my-engine:
    type: mysql | postgres          # required
    url: mysql://user:pass@host:port/db  # preferred; password masked on display as :***@
```

URL is the canonical format. Postgres URLs pass directly to `pg.Pool({ connectionString })`. Never log raw connection URLs — use the `:***@` masking pattern.

## Testing Conventions

- **Unit tests**: Vitest, located alongside source (`src/connectors/*.test.ts`)
- Mock driver pools via `vi.fn()` on the private `pools` Map using `@ts-expect-error`
- **Integration tests**: `test/test-blocking.mjs` requires `docker compose up -d` first
- Run `npm test` after any connector or tool change

## Branch & PR Conventions (from SPRINT.md)

- Branch: `feature/<engine>-<feature>` or `bugfix/<short-description>`
- One PR per task; squash-and-merge to keep `main` history clean
- Labels: `engine:<name>`, `type:feature`/`type:bugfix`, `sprint:<N>`
