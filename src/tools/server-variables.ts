import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the server-variables tool on the MCP server.
 * Returns a curated subset of server configuration variables.
 */
export function registerServerVariablesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "server-variables",
    "List server configuration variables (curated subset). " +
    "MySQL: SHOW VARIABLES. PostgreSQL: pg_settings. " +
    "SQL Server: sys.configurations. Oracle: v$parameter. " +
    "MongoDB: serverStatus command. " +
    "Returns array of {name, value, description?}.",
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
        const vars = await connector.listServerVariables(engineId, engine);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ variables: vars, count: vars.length }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error listing server variables on "${engineId}": ${message}` }],
          isError: true,
        };
      }
    }
  );
}