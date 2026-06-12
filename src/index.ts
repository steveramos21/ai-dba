import { McpServer } from "@modelcontextprotocol/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
// Import engine-specific implementations
import { getBlockingChainsMySQL } from "./engines/mysql";
import { getBlockingChainsPostgreSQL } from "./engines/postgres";
import { getBlockingChainsSqlServer } from "./engines/sqlserver";
import { getBlockingChainsOracle } from "./engines/oracle";
import { getBlockingChainsMongoDB } from "./engines/mongodb";
import { BlockingChain } from "./types";

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
  const configPath = require("path").resolve(process.cwd(), "config.yaml");
  const fs = require("fs");
  if (!fs.existsSync(configPath)) {
    console.warn("config.yaml not found, using empty config");
    return { engines: {} };
  }
  // For simplicity, assume YAML parsing; in reality use yaml library
  // We'll just return empty for now
  return { engines: {} };
}

// Map engineId to function
const engineFunctions: Record<string, (config: EngineConfig) => Promise<BlockingChain[]>> = {
  mysql: getBlockingChainsMySQL,
  postgres: getBlockingChainsPostgreSQL,
  sqlserver: getBlockingChainsSqlServer,
  oracle: getBlockingChainsOracle,
  mongodb: getBlockingChainsMongoDB,
};

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
      const engineConfig = engines[engineId];
      const func = engineFunctions[engineConfig.type];
      if (!func) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported engine type: ${engineConfig.type}`,
            },
          ],
        };
      }
      const chains = await func(engineConfig);
      results.push({ engineId, chains });
    } else {
      for (const [id, eng] of Object.entries(engines)) {
        const func = engineFunctions[eng.type];
        if (!func) {
          console.warn(`Unsupported engine type: ${eng.type} for engine ${id}`);
          continue;
        }
        const chains = await func(eng);
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
