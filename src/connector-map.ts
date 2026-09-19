import type { DatabaseConnector } from "./connector.js";
import { mysqlConnector } from "./connectors/mysql.js";
import { postgresConnector } from "./connectors/postgres.js";
import { sqlserverConnector } from "./connectors/sqlserver.js";
import { oracleConnector } from "./connectors/oracle.js";
import { mongodbConnector } from "./connectors/mongodb.js";

/**
 * Build the connector map for all supported engine types.
 *
 * Lives here (not in server.ts) so the CLI never imports the MCP SDK:
 * connector instances are cheap until a driver is loaded on first use,
 * and this module keeps the CLI's module graph SDK-free.
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
 * Graceful shutdown: close all database pools across all connectors.
 * @param connectors Connector map (defaults to all registered connectors)
 */
export async function shutdown(connectors?: Record<string, DatabaseConnector>): Promise<void> {
  const map = connectors ?? buildConnectorMap();
  for (const connector of Object.values(map)) {
    await connector.closeAllPools();
  }
}
