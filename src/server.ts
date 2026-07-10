import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "./config.js";
import type { DatabaseConnector } from "./connector.js";
import { mysqlConnector } from "./connectors/mysql.js";
import { postgresConnector } from "./connectors/postgres.js";
import { sqlserverConnector } from "./connectors/sqlserver.js";
import { oracleConnector } from "./connectors/oracle.js";
import { mongodbConnector } from "./connectors/mongodb.js";
import { registerBlockingChainsTool } from "./tools/blocking-chains.js";
import { registerDatabasesTool } from "./tools/databases.js";
import { registerTablesTool } from "./tools/tables.js";
import { registerDescribeTableTool } from "./tools/describe-table.js";
import { registerIndexesTool } from "./tools/indexes.js";
import { registerProcessesTool } from "./tools/processes.js";

/**
 * Build the connector map for all supported engine types.
 */
export function buildConnectorMap(): Record<string, DatabaseConnector> {
  return {
    mysql: mysqlConnector,
    postgres: postgresConnector,
    sqlserver: sqlserverConnector,
    oracle: oracleConnector,
    mongodb: mongodbConnector,
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
  registerDatabasesTool(server, config, connectors);
  registerTablesTool(server, config, connectors);
  registerDescribeTableTool(server, config, connectors);
  registerIndexesTool(server, config, connectors);
  registerProcessesTool(server, config, connectors);

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