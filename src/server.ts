import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "./config.js";
import type { DatabaseConnector } from "./connector.js";
import { mysqlConnector } from "./connectors/mysql.js";
import { postgresConnector } from "./connectors/postgres.js";
import { registerBlockingChainsTool } from "./tools/blocking-chains.js";

/**
 * Build the connector map for all supported engine types.
 */
export function buildConnectorMap(): Record<string, DatabaseConnector> {
  return {
    mysql: mysqlConnector,
    postgres: postgresConnector,
  };
}

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

  return server;
}

/**
 * Graceful shutdown: close all database pools across all connectors.
 * @param connectors Connector map (defaults to all registered connectors)
 */
export async function shutdown(connectors?: Record<string, DatabaseConnector>): Promise<void> {
  const map = connectors ?? buildConnectorMap();
  for (const connector of Object.values(map)) {
    await connector.closeAllPools();
  }
}