import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";
import { validateExplainQuery, isJsonCommand } from "../sql-guard.js";

/**
 * Register the explain tool on the MCP server.
 * Returns the execution plan for a query.
 */
export function registerExplainTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "explain",
    "Get the execution plan for a SQL query (EXPLAIN). " +
    "MySQL uses EXPLAIN FORMAT=JSON; PostgreSQL uses EXPLAIN (FORMAT JSON); " +
    "SQL Server uses SET SHOWPLAN_XML (returns XML); " +
    "Oracle uses EXPLAIN PLAN + DBMS_XPLAN.DISPLAY (returns text); " +
    "MongoDB requires a JSON command document like {\"find\": \"collection\", \"filter\": {}}. " +
    "WARNING: When analyze=true, PostgreSQL actually EXECUTES the query (EXPLAIN ANALYZE) — " +
    "do not use with INSERT/UPDATE/DELETE or expensive queries.",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      query: z.string().describe(
        "SQL query to explain (SELECT, WITH, etc.). For MongoDB, pass a JSON command document like {\"find\": \"users\", \"filter\": {}}"
      ),
      analyze: z.boolean().optional().describe(
        "If true, run EXPLAIN ANALYZE (actually executes the query). Default: false. PostgreSQL only — MySQL/SQL Server/Oracle ignore this flag."
      ),
    },
    async ({ engineId, query, analyze }) => {
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
        // Validate input — security-critical when analyze=true (PostgreSQL executes the query)
        if (engine.type === "mongodb") {
          if (!isJsonCommand(query)) {
            return {
              content: [{ type: "text" as const, text: 'MongoDB explain requires a JSON command document, e.g. {"find": "collection", "filter": {}}' }],
              isError: true,
            };
          }
        } else {
          validateExplainQuery(query, analyze ?? false);
        }

        const result = await connector.explainQuery(engineId, engine, query, { analyze: analyze ?? false });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error explaining query on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}