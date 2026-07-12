import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector } from "../connector.js";

/**
 * Register the kill-process tool on the MCP server.
 * First write operation — guided remediation with confirm flag.
 * Dry-run by default (confirm=false). Executes only when confirm=true.
 * Requires allowWriteOps: true in config.yaml.
 */
export function registerKillProcessTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "kill-process",
    "Kill a database process/session. " +
    "By default (confirm=false), returns a dry-run proposal showing what would be killed. " +
    "Set confirm=true to execute the kill. " +
    "Requires allowWriteOps: true in config.yaml. " +
    "MySQL/PostgreSQL/SQL Server/MongoDB: pid is a positive integer. " +
    "Oracle: pid is 'SID,SERIAL#' (e.g., '42,123').",
    {
      engineId: z.string().describe(
        "Engine identifier from config.yaml (e.g., 'mysql-primary')"
      ),
      pid: z.string().describe(
        "Process ID to kill. Integer for most engines, 'SID,SERIAL#' for Oracle."
      ),
      confirm: z.boolean().optional().describe(
        "Set to true to execute the kill. Default: false (dry-run only)."
      ),
    },
    async ({ engineId, pid, confirm }) => {
      const engine = config.engines[engineId];

      if (!engine) {
        return {
          content: [{ type: "text" as const, text: `Unknown engine "${engineId}". Available: ${Object.keys(config.engines).join(", ")}` }],
          isError: true,
        };
      }

      if (!engine.allowWriteOps) {
        return {
          content: [{ type: "text" as const, text: `Write operations disabled for engine "${engineId}". Set allowWriteOps: true in config.yaml.` }],
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
        const dryRun = !confirm;
        const result = await connector.killProcess(engineId, engine, pid, { dryRun });

        if (dryRun && result.wouldKill) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ proposal: result, message: "Dry-run only. Set confirm=true to execute." }, null, 2),
            }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success ? true : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error killing process ${pid} on "${engineId}": ${message}` }],
          isError: true,
        };
      }
    }
  );
}