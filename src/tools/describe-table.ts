import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the describe-table tool on the MCP server.
 * Returns column metadata for a specific table.
 */
export function registerDescribeTableTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "describe-table",
    "Describe column metadata for a specific table on a database engine. " +
    "Returns column name, type, nullable, default value, primary key, and auto-increment info. " +
    "PostgreSQL accepts schema-qualified names like 'public.users'.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      table: z.string().describe(
        "Table name to describe (e.g., 'users' or 'public.users' for PostgreSQL)"
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
        const columns = await connector.describeTable(engineId, engine, table, database);

        if (columns.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ columns: [], count: 0, message: `Table "${table}" not found or has no columns` }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ columns, count: columns.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error describing table "${table}" on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}