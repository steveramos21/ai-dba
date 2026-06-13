import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import { getBlockingChainsMySQL, closeAllPools } from "../connectors/mysql.js";

/**
 * Register the blocking-chains tool on the MCP server.
 */
export function registerBlockingChainsTool(server: McpServer, config: AiDbaConfig): void {
  server.tool(
    "blocking-chains",
    "Get current blocking chain details from a database engine. " +
    "Returns blocked sessions, blockers, wait duration, and the queries involved. " +
    "Requires performance_schema to be enabled (MySQL 8.0 default).",
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

      if (engine.type !== "mysql") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Engine "${engineId}" is type "${engine.type}". Only MySQL is currently supported for blocking-chains.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const chains = await getBlockingChainsMySQL(engineId, engine);

        if (chains.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No blocking chains found on engine "${engineId}".`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(chains, null, 2),
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

/**
 * Close all connection pools. Call on server shutdown.
 */
export { closeAllPools };