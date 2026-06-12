import { McpServer } from "@modelcontextprotocol/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mysql2 as mysql } from "mysql2";
import { Pool as pgPool } from "pg";
import { Connection as tediousConnection } from "tedious";
import { MongoClient } from "mongodb";
import { oracledb } from "oracledb";

// Load configuration
import * as fs from "fs";
import * as path from "path";

interface EngineConfig {
  type: "mysql" | "postgres" | "sqlserver" | "oracle" | "mongodb";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  // engine-specific options can be added
}

interface AiDbaConfig {
  engines: Record<string, EngineConfig>;
}

// Simple config loader
function loadConfig(): AiDbaConfig {
  const configPath = path.resolve(process.cwd(), "config.yaml");
  if (!fs.existsSync(configPath)) {
    console.warn("config.yaml not found, using empty config");
    return { engines: {} };
  }
  // For simplicity, assume YAML parsing; in reality use yaml library
  // We'll just return empty for now
  return { engines: {} };
}

// Define BlockingChain type
interface BlockingChain {
  blocking_pid: string | number;
  blocked_pid: string | number;
  wait_duration_ms: number;
  wait_event: string;
  blocking_query?: string;
  blocked_query?: string;
  database_name?: string;
  wait_type?: string;
  status?: string;
  login_time?: string; // ISO string
  host_name?: string;
  program_name?: string;
}

// Placeholder: implement per-engine queries later
async function getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]> {
  // TODO: implement per engine
  console.log(`Querying blocking chains for ${engineId} (${config.type})`);
  return [];
}

// Set up MCP server
const server = new McpServer({
  name: "ai-dba-diagnostics",
  version: "1.0.0",
});

// Register the blocking-chains tool
server.tool(
  "blocking-chains",
  {
    // Input schema: maybe engine id or all
    engineId: { type: "string", description: "Engine identifier (optional, if not provided returns all)" },
  },
  async ({ engineId }) => {
    const config = loadConfig();
    const engines = config.engines;
    let results: { engineId: string; chains: BlockingChain[] }[] = [];

    if (engineId) {
      if (!engines[engineId]) {
        return {
          content: [
            {
              type: "text",
              text: `Engine ${engineId} not found in configuration`,
            },
          ],
        };
      }
      const chains = await getBlockingChains(engineId, engines[engineId]);
      results.push({ engineId, chains });
    } else {
      for (const [id, eng] of Object.entries(engines)) {
        const chains = await getBlockingChains(id, eng);
        results.push({ engineId: id, chains });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    },
  }
);

// Start server via stdio
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AI-DBA Diagnostics MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
