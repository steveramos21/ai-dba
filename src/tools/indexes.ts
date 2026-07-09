import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the indexes tool on the MCP server.
 * Lists indexes on a specific table.
 */
export function registerIndexesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "indexes",
    "List indexes on a specific table on a database engine. " +
    "Returns index name, columns, uniqueness, and index type. " +
    "MySQL reads from INFORMATION_SCHEMA.STATISTICS; PostgreSQL reads from pg_indexes.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      table: z.string().describe(
        "Table name (e.g., 'users' or 'public.users' for PostgreSQL)"
      ),
      database: z.string().optional().describe(
        "Database/schema name (optional — defaults to the engine's configured database)"
      ),
    },
    async ({ engineId, table, database }) => {
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
        const indexes = await connector.listIndexes(engineId, engine, table, database);

        if (indexes.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ indexes: [], count: 0, message: `No indexes found on table "${table}"` }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ indexes, count: indexes.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing indexes on table "${table}" on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}