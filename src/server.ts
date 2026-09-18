import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "./config.js";
import { buildConnectorMap, shutdown } from "./connector-map.js";
import { registerBlockingChainsTool } from "./tools/blocking-chains.js";
import { registerDatabasesTool } from "./tools/databases.js";
import { registerTablesTool } from "./tools/tables.js";
import { registerDescribeTableTool } from "./tools/describe-table.js";
import { registerIndexesTool } from "./tools/indexes.js";
import { registerProcessesTool } from "./tools/processes.js";
import { registerTableSizesTool } from "./tools/table-sizes.js";
import { registerExplainTool } from "./tools/explain.js";
import { registerSlowQueriesTool } from "./tools/slow-queries.js";
import { registerHealthCheckTool } from "./tools/health-check.js";
import { registerKillProcessTool } from "./tools/kill-process.js";
import { registerReplicationStatusTool } from "./tools/replication-status.js";
import { registerServerVariablesTool } from "./tools/server-variables.js";
import { registerServerStatusTool } from "./tools/server-status.js";

/**
 * Create and configure the AI-DBA diagnostics MCP server.
 */
export function createServer(config: AiDbaConfig): McpServer {
  const server = new McpServer({
    name: "ai-dba-diagnostics",
    version: "1.0.0",
  });

  const connectors = buildConnectorMap();

  // Register tools
  registerBlockingChainsTool(server, config, connectors);
  registerDatabasesTool(server, config, connectors);
  registerTablesTool(server, config, connectors);
  registerDescribeTableTool(server, config, connectors);
  registerIndexesTool(server, config, connectors);
  registerProcessesTool(server, config, connectors);
  registerTableSizesTool(server, config, connectors);
  registerExplainTool(server, config, connectors);
  registerSlowQueriesTool(server, config, connectors);
  registerHealthCheckTool(server, config, connectors);
  registerKillProcessTool(server, config, connectors);
  registerReplicationStatusTool(server, config, connectors);
  registerServerVariablesTool(server, config, connectors);
  registerServerStatusTool(server, config, connectors);

  return server;
}

// Re-exported for compatibility — the `serve` command imports both from here.
// New code should import from "./connector-map.js" directly.
export { buildConnectorMap, shutdown };