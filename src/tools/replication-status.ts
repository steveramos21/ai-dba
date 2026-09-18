import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the replication-status tool on the MCP server.
 * Returns normalized replication status: role, lagSeconds, status, errorMessage.
 */
export function registerReplicationStatusTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "replication-status",
    "Get replication status for an engine. " +
    "Returns: role (engine-native), lagSeconds, status (healthy/degraded/down/not_configured), errorMessage. " +
    "MySQL: SHOW REPLICA STATUS. PostgreSQL: pg_stat_replication/pg_stat_wal_receiver. " +
    "SQL Server: AlwaysOn Availability Groups. Oracle: Data Guard (v$database/v$dataguard_status). " +
    "MongoDB: replSetGetStatus.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
    },
    async ({ engineId }) => {
      const engine = config.engines[engineId];

      if (!engine) {
        return {
          content: [{ type: "text" as const, text: `Unknown engine "${engineId}". Available: ${Object.keys(config.engines).join(", ")}` }],
          isError: true,
        };
      }

      const connector = connectors[engine.type];
      if (!connector) {
        return {
          content: [{ type: "text" as const, text: `No connector for engine type "${engine.type}".` }],
          isError: true,
        };
      }

      try {
        const status = await connector.listReplicationStatus(engineId, engine);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error getting replication status on "${engineId}": ${message}` }],
          isError: true,
        };
      }
    }
  );
}