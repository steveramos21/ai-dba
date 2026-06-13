import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AiDbaConfig } from "./config.js";
import { registerBlockingChainsTool, closeAllPools } from "./tools/blocking-chains.js";

/**
 * Create and configure the AI-DBA diagnostics MCP server.
 */
export function createServer(config: AiDbaConfig): McpServer {
  const server = new McpServer({
    name: "ai-dba-diagnostics",
    version: "1.0.0",
  });

  // Register tools
  registerBlockingChainsTool(server, config);

  return server;
}

/**
 * Graceful shutdown: close all database pools.
 */
export async function shutdown(): Promise<void> {
  await closeAllPools();
}