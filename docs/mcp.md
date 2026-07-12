# MCP Server

AI-DBA runs as an MCP (Model Context Protocol) server, exposing database diagnostics as tools for AI agents.

## Starting the Server

```bash
node dist/index.js --config config.yaml serve
```

The server communicates over stdio (JSON-RPC).

## MCP Tools

Ten tools are registered:

### `databases`
List databases/schemas on an engine.
```json
{"name": "databases", "arguments": {"engineId": "my-mysql"}}
```

### `tables`
List tables (optional database/schema filter).
```json
{"name": "tables", "arguments": {"engineId": "my-mysql", "database": "information_schema"}}
```

### `describe-table`
Show column metadata for a table.
```json
{"name": "describe-table", "arguments": {"engineId": "my-mysql", "table": "blocking_test"}}
```

### `indexes`
List indexes for a table.
```json
{"name": "indexes", "arguments": {"engineId": "my-mysql", "table": "blocking_test"}}
```

### `processes`
List active connections/sessions.
```json
{"name": "processes", "arguments": {"engineId": "my-mysql"}}
```

### `blocking-chains`
Detect blocking chains.
```json
{"name": "blocking-chains", "arguments": {"engineId": "my-mysql"}}
```

### `table-sizes`
List table sizes with data/index/total breakdown.
```json
{"name": "table-sizes", "arguments": {"engineId": "my-mysql", "database": "information_schema"}}
```

### `explain`
Show execution plan for a query. For MongoDB, `query` is a JSON command document.
```json
{"name": "explain", "arguments": {"engineId": "my-mysql", "query": "SELECT * FROM users WHERE id = 1", "analyze": false}}
```
Set `analyze: true` for `EXPLAIN ANALYZE` (PostgreSQL executes the query; MySQL ignores the flag).

### `slow-queries`
List slow queries from engine internals. Returns empty array if the feature is unavailable.
```json
{"name": "slow-queries", "arguments": {"engineId": "my-mysql", "limit": 10, "minDurationMs": 1000}}
```

### `health-check`
Run a health check — orchestrates connectivity, blocking chains, processes, and slow queries.
```json
{"name": "health-check", "arguments": {"engineId": "my-mysql"}}
```
Returns `status: "healthy" | "warning" | "critical"` with per-check breakdown.

## Integration with AI Agents

### Hermes Agent

Add to your MCP client config:

```yaml
mcp_servers:
  ai-dba:
    command: node
    args: ["/path/to/ai-dba/dist/index.js", "--config", "/path/to/ai-dba/config.yaml", "serve"]
```

### Claude Code

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-dba": {
      "command": "node",
      "args": ["/path/to/ai-dba/dist/index.js", "--config", "/path/to/ai-dba/config.yaml", "serve"]
    }
  }
}
```

### Cursor

Add to MCP settings:

```json
{
  "mcp.ai-dba": {
    "command": "node",
    "args": ["/path/to/ai-dba/dist/index.js", "--config", "/path/to/ai-dba/config.yaml", "serve"]
  }
}
```

## Read-Only Guardrails

The `query` tool (available via `sql` REPL command) enforces read-only access:

- **MySQL:** Allows `SELECT`, `SHOW`, `WITH`, `EXPLAIN`, `DESCRIBE`
- **PostgreSQL:** Allows `SELECT`, `WITH`, `EXPLAIN`
- **SQL Server:** Allows `SELECT`, `WITH`, `EXPLAIN`
- **Oracle:** Allows `SELECT`, `WITH`, `EXPLAIN`, `DESCRIBE`
- **MongoDB:** Allows `find`, `aggregate`, `count`, `distinct`, `ping`

Any write operation (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `createCollection`, etc.) is rejected with an error message.