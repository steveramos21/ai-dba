import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the tables tool on the MCP server.
 * Lists tables in a database/schema on the target engine.
 */
export function registerTablesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "tables",
    "List tables in a database/schema on a database engine. " +
    "MySQL lists tables from INFORMATION_SCHEMA.TABLES for the configured database; " +
    "PostgreSQL lists tables from pg_tables in visible schemas. " +
    "Pass an optional database/schema name to override the configured one.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      database: z.string().optional().describe(
        "Database/schema name (optional — defaults to the engine's configured database)"
      ),
    },
    async ({ engineId, database }) => {
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
        const tables = await connector.listTables(engineId, engine, database);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ tables, count: tables.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing tables on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}