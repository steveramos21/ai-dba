#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { createServer, shutdown } from "./server.js";

const program = new Command();

program
  .name("ai-dba-diagnostics")
  .description("AI-DBA Diagnostics MCP Server — read-only database diagnostics over stdio")
  .version("1.0.0")
  .option("-c, --config <path>", "Path to config.yaml", "config.yaml")
  .action(async (options: { config: string }) => {
    try {
      const config = loadConfig(options.config);
      const server = createServer(config);
      const transport = new StdioServerTransport();

      await server.connect(transport);

      console.error(`AI-DBA Diagnostics MCP Server running on stdio`);
      console.error(`Config: ${options.config}`);
      console.error(`Engines: ${Object.keys(config.engines).join(", ") || "(none configured)"}`);

      // Graceful shutdown
      process.on("SIGINT", async () => {
        console.error("Shutting down...");
        await shutdown();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        console.error("Shutting down...");
        await shutdown();
        process.exit(0);
      });
    } catch (err) {
      console.error("Failed to start MCP server:", err);
      process.exit(1);
    }
  });

program.parse();