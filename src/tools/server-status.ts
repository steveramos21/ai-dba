import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the server-status tool on the MCP server.
 * Returns a curated subset of server runtime status metrics.
 */
export function registerServerStatusTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "server-status",
    "List server runtime status metrics (curated subset). " +
    "MySQL: SHOW GLOBAL STATUS. PostgreSQL: pg_stat_database + pg_stat_activity. " +
    "SQL Server: @@ system variables + DMV counts. Oracle: v$sysstat. " +
    "MongoDB: serverStatus command. " +
    "Returns array of {name, value}.",
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
        const metrics = await connector.listServerStatus(engineId, engine);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ metrics, count: metrics.length }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error listing server status on "${engineId}": ${message}` }],
          isError: true,
        };
      }
    }
  );
}