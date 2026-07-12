import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "../config.js";
import type { DatabaseConnector, HealthCheck, HealthCheckResult } from "../connector.js";

/**
 * Register the health-check tool on the MCP server.
 * Orchestrates existing connector methods (getBlockingChains, listProcesses, listSlowQueries, query)
 * to produce a single health summary. No new connector queries — pure tool-layer orchestration.
 */
export function registerHealthCheckTool(
  server: McpServer,
  config: AiDbaConfig,
  connectors: Record<string, DatabaseConnector>,
): void {
  server.tool(
    "health-check",
    "Run a health check on a database engine. Returns overall status (healthy/warning/critical) " +
    "with per-check breakdown: connectivity (ping), blocking chains, active processes, slow queries. " +
    "Critical if connectivity fails or blocking chains exist. Warning if slow queries found or " +
    "process count is high (>50). Uses existing connector methods — no engine-specific queries.",
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

      const checks: HealthCheck[] = [];

      // 1. Connectivity — ping the database
      try {
        const probeSql =
          engine.type === "oracle" ? "SELECT 1 FROM DUAL" :
          engine.type === "mongodb" ? JSON.stringify({ ping: 1 }) :
          "SELECT 1";
        await connector.query(engineId, engine, probeSql);
        checks.push({ name: "connectivity", status: "pass", message: "Database is reachable" });
      } catch (e: any) {
        checks.push({ name: "connectivity", status: "fail", message: e instanceof Error ? e.message : String(e) });
      }

      // 2. Blocking chains — reuse existing method
      try {
        const chains = await connector.getBlockingChains(engineId, engine);
        if (chains.length === 0) {
          checks.push({ name: "blocking", status: "pass", message: "No blocking chains", value: 0 });
        } else {
          checks.push({
            name: "blocking",
            status: "fail",
            message: `${chains.length} blocking chain(s) detected`,
            value: chains.length,
          });
        }
      } catch (e: any) {
        checks.push({ name: "blocking", status: "skip", message: e instanceof Error ? e.message : String(e) });
      }

      // 3. Active processes — reuse existing method
      try {
        const procs = await connector.listProcesses(engineId, engine);
        const count = procs.length;
        if (count > 50) {
          checks.push({ name: "processes", status: "warn", message: `High process count: ${count}`, value: count });
        } else {
          checks.push({ name: "processes", status: "pass", message: `${count} active process(es)`, value: count });
        }
      } catch (e: any) {
        checks.push({ name: "processes", status: "skip", message: e instanceof Error ? e.message : String(e) });
      }

      // 4. Slow queries — reuse existing method
      try {
        const slowQueries = await connector.listSlowQueries(engineId, engine, { limit: 5, minDurationMs: 1000 });
        if (slowQueries.length === 0) {
          checks.push({ name: "slow-queries", status: "pass", message: "No slow queries detected", value: 0 });
        } else {
          checks.push({
            name: "slow-queries",
            status: "warn",
            message: `${slowQueries.length} slow query pattern(s) found`,
            value: slowQueries.length,
          });
        }
      } catch (e: any) {
        checks.push({ name: "slow-queries", status: "skip", message: e instanceof Error ? e.message : String(e) });
      }

      // Aggregate status: critical if any fail, warning if any warn, healthy if all pass
      const hasFail = checks.some((c) => c.status === "fail");
      const hasWarn = checks.some((c) => c.status === "warn");
      const status: HealthCheckResult["status"] =
        hasFail ? "critical" :
        hasWarn ? "warning" :
        "healthy";

      const result: HealthCheckResult = {
        status,
        engineId,
        engineType: engine.type,
        checks,
        timestamp: new Date().toISOString(),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}