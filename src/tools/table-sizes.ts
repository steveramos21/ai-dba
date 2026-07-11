import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the table-sizes tool on the MCP server.
 * Lists table sizes (data, index, total) for a database/schema on the target engine.
 */
export function registerTableSizesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "table-sizes",
    "List table sizes (data bytes, index bytes, total bytes, rows) for a database/schema. " +
    "Sorted by total size descending. MySQL uses INFORMATION_SCHEMA.TABLES; " +
    "PostgreSQL uses pg_relation_size/pg_indexes_size/pg_total_relation_size; " +
    "SQL Server uses sys.allocation_units; Oracle uses user_segments/all_segments; " +
    "MongoDB uses collStats. " +
    "Note: the 'database' parameter means database name for MySQL/MongoDB, " +
    "schema name for PostgreSQL/SQL Server, or owner/schema for Oracle.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      database: z.string().optional().describe(
        "Database/schema/owner name (optional — defaults to the engine's configured database)"
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
        const sizes = await connector.listTableSizes(engineId, engine, database);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ tableSizes: sizes, count: sizes.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing table sizes on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}