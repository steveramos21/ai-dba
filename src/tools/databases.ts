import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the databases tool on the MCP server.
 * Lists all databases/schemas on the target server.
 */
export function registerDatabasesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "databases",
    "List all databases/schemas on a database engine (MySQL or PostgreSQL). " +
    "MySQL returns databases from INFORMATION_SCHEMA.SCHEMATA; PostgreSQL returns non-template databases from pg_database.",
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
        const databases = await connector.listDatabases(engineId, engine);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ databases, count: databases.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing databases on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}