import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the slow-queries tool on the MCP server.
 * Lists slow queries from engine internals (performance_schema, pg_stat_statements, etc.)
 */
export function registerSlowQueriesTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "slow-queries",
    "List slow queries from engine internals. " +
    "MySQL uses performance_schema.events_statements_summary_by_digest; " +
    "PostgreSQL uses pg_stat_statements (requires extension); " +
    "SQL Server uses sys.dm_exec_query_stats (requires VIEW SERVER STATE); " +
    "Oracle uses v$sqlarea (requires SELECT ANY DICTIONARY); " +
    "MongoDB uses currentOp (shows currently running ops, not historical). " +
    "Returns empty array if the feature is unavailable or insufficient privileges.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      limit: z.number().int().min(1).max(100).optional().describe(
        "Maximum number of queries to return (default: 10)"
      ),
      minDurationMs: z.number().int().min(0).optional().describe(
        "Minimum total execution time in milliseconds (default: 1000)"
      ),
    },
    async ({ engineId, limit, minDurationMs }) => {
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
        const queries = await connector.listSlowQueries(engineId, engine, {
          limit: limit ?? 10,
          minDurationMs: minDurationMs ?? 1000,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ slowQueries: queries, count: queries.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing slow queries on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}