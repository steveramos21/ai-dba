import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the blocking-chains tool on the MCP server.
 * @param connectors Map of engine type -> connector instance
 */
export function registerBlockingChainsTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "blocking-chains",
    "Get current blocking chain details from a database engine (MySQL or PostgreSQL). " +
    "Returns blocked sessions, blockers, wait duration, and the queries involved. " +
    "MySQL uses INNODB_LOCK_WAITS + INNODB_TRX; PostgreSQL uses pg_blocking_pids() + pg_stat_activity.",
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
        const chains = await connector.getBlockingChains(engineId, engine);

        if (chains.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ chains: [], count: 0, message: "No blocking chains found" }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ chains, count: chains.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error querying blocking chains on "${engineId}": ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}