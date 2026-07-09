import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the processes tool on the MCP server.
 * Lists active database connections/processes, excluding the current session.
 */
export function registerProcessesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "processes",
    "List active database processes/connections on a database engine (excludes the querying session itself). " +
    "MySQL reads from INFORMATION_SCHEMA.PROCESSLIST; PostgreSQL reads from pg_stat_activity. " +
    "Returns PID, user, host, database, command/state, duration, and current query.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
    },
    async ({ engineId }) => {
      const engine = config.engines[engineId];

      if (!engine) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown engine "${engineId}". Available engines: ${Object.keys(config.engines).join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const connector = connectors[engine.type];
      if (!connector) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Engine "${engineId}" is type "${engine.type}". No connector registered for this engine type.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const processes = await connector.listProcesses(engineId, engine);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ processes, count: processes.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing processes on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}