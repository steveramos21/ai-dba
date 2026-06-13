#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { loadConfig, parseMysqlUrl, resolveMysqlConfig } from "./config.js";
import type { EngineConfig } from "./config.js";
// All heavy imports are dynamic — loaded only when the command runs.
// This keeps the CLI fast and prevents the event loop from hanging
// on MCP SDK / mysql2 listeners when running one-off commands.

const program = new Command();

program
  .name("ai-dba")
  .description("AI-DBA: Universal database copilot — diagnostics and operations")
  .version("1.0.0")
  .option("-c, --config <path>", "Path to config.yaml", "config.yaml");

// ─── MCP Server (stdio) ───────────────────────────────────────
program
  .command("serve")
  .description("Start MCP server over stdio (for AI agents)")
  .action(async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createServer, shutdown } = await import("./server.js");
    const opts = program.opts();
    try {
      const config = loadConfig(opts.config);
      const server = createServer(config);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`AI-DBA Diagnostics MCP Server running on stdio`);
      console.error(`Config: ${opts.config}`);
      console.error(`Engines: ${Object.keys(config.engines).join(", ") || "(none configured)"}`);

      const cleanup = async () => {
        console.error("Shutting down...");
        await shutdown();
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    } catch (err) {
      console.error("Failed to start MCP server:", err);
      process.exit(1);
    }
  });

// ─── blocking-chains ───────────────────────────────────────────
program
  .command("blocking-chains <engineId>")
  .description("Show current blocking chains for an engine")
  .option("--json", "Output raw JSON instead of a table")
  .action(async (engineId: string, cmdOpts: { json?: boolean }) => {
    const { getBlockingChainsMySQL, closeAllPools } = await import("./connectors/mysql.js");
    const opts = program.opts();
    const config = loadConfig(opts.config);
    const engine = config.engines[engineId];

    if (!engine) {
      console.error(chalk.red(`Unknown engine "${engineId}". Available: ${Object.keys(config.engines).join(", ")}`));
      process.exit(1);
    }

    if (engine.type !== "mysql") {
      console.error(chalk.red(`Engine "${engineId}" is type "${engine.type}". Only MySQL is currently supported for blocking-chains.`));
      process.exit(1);
    }

    try {
      const chains = await getBlockingChainsMySQL(engineId, engine);

      if (cmdOpts.json) {
        console.log(JSON.stringify(chains, null, 2));
      } else if (chains.length === 0) {
        console.log(chalk.green("No blocking chains found on") + chalk.cyan(` ${engineId}`));
      } else {
        const table = new Table({
          head: [
            chalk.white("Blocking PID"),
            chalk.white("Blocked PID"),
            chalk.white("Wait"),
            chalk.white("Database"),
            chalk.white("Blocking Query"),
            chalk.white("Blocked Query"),
          ],
          colWidths: [14, 14, 12, 14, 40, 40],
          wordWrap: true,
        });

        for (const c of chains) {
          table.push([
            c.blocking_pid,
            c.blocked_pid,
            c.wait_event,
            c.database_name ?? "-",
            (c.blocking_query ?? "-").substring(0, 80),
            (c.blocked_query ?? "-").substring(0, 80),
          ]);
        }
        console.log(table.toString());
        console.log(chalk.yellow(`${chains.length} blocking chain(s) on`) + chalk.cyan(` ${engineId}`));
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    } finally {
      await closeAllPools();
      process.exit(0);
    }
  });

// ─── connect ───────────────────────────────────────────────────
program
  .command("connect <url>")
  .description("Connect to a database via URL and show its status")
  .option("--json", "Output raw JSON instead of a table")
  .action(async (url: string, cmdOpts: { json?: boolean }) => {
    const { getBlockingChainsMySQL, closeAllPools } = await import("./connectors/mysql.js");

    let engineConfig: EngineConfig;
    if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
      engineConfig = { type: "mysql", url: url.replace(/^mysql2:/, "mysql:") };
    } else if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
      console.error(chalk.red("PostgreSQL is not yet supported."));
      process.exit(1);
    } else {
      console.error(chalk.red("Unsupported URL scheme. Use mysql:// or postgresql://"));
      process.exit(1);
    }

    const parsed = parseMysqlUrl(engineConfig.url!);
    const engineId = `${parsed.host}-${parsed.database}`;

    console.log(chalk.green(`Connected to`) + chalk.cyan(` ${engineId}`));
    console.log(chalk.dim(`  mysql://${parsed.user}:***@${parsed.host}:${parsed.port}/${parsed.database}`));

    try {
      const chains = await getBlockingChainsMySQL(engineId, engineConfig);
      if (cmdOpts.json) {
        console.log(JSON.stringify(chains, null, 2));
      } else if (chains.length === 0) {
        console.log(chalk.green("No blocking chains found."));
      } else {
        const table = new Table({
          head: [
            chalk.white("Blocking PID"),
            chalk.white("Blocked PID"),
            chalk.white("Wait"),
            chalk.white("Database"),
            chalk.white("Blocking Query"),
            chalk.white("Blocked Query"),
          ],
          colWidths: [14, 14, 12, 14, 40, 40],
          wordWrap: true,
        });

        for (const c of chains) {
          table.push([
            c.blocking_pid,
            c.blocked_pid,
            c.wait_event,
            c.database_name ?? "-",
            (c.blocking_query ?? "-").substring(0, 80),
            (c.blocked_query ?? "-").substring(0, 80),
          ]);
        }
        console.log(table.toString());
        console.log(chalk.yellow(`${chains.length} blocking chain(s)`));
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    } finally {
      await closeAllPools();
      process.exit(0);
    }
  });
program
  .command("list-engines")
  .description("List configured database engines")
  .action(() => {
    const opts = program.opts();
    const config = loadConfig(opts.config);
    const entries = Object.entries(config.engines);

    if (entries.length === 0) {
      console.log(chalk.yellow("No engines configured. Edit config.yaml"));
    } else {
      const table = new Table({
        head: [chalk.white("ID"), chalk.white("Type"), chalk.white("Host"), chalk.white("Port"), chalk.white("Database"), chalk.white("URL")],
      });
      for (const [id, engine] of entries) {
        if (engine.url) {
          const parsed = parseMysqlUrl(engine.url);
          table.push([chalk.cyan(id), engine.type, parsed.host, String(parsed.port), parsed.database, chalk.dim(engine.url)]);
        } else {
          table.push([chalk.cyan(id), engine.type, engine.host ?? "-", String(engine.port ?? 3306), engine.database ?? "-", "-"]);
        }
      }
      console.log(table.toString());
    }
    process.exit(0);
  });

// ─── Interactive REPL ──────────────────────────────────────────
program
  .command("repl")
  .description("Interactive REPL for database diagnostics")
  .action(async () => {
    const { getBlockingChainsMySQL, closeAllPools } = await import("./connectors/mysql.js");
    const opts = program.opts();

    // Load config if it exists, otherwise start with empty engines
    let config: { engines: Record<string, EngineConfig> };
    try {
      config = loadConfig(opts.config);
    } catch {
      config = { engines: {} };
    }

    const engineIds = () => Object.keys(config.engines);
    let currentEngine = engineIds()[0] ?? "";

    console.log(chalk.cyan.bold("AI-DBA REPL") + chalk.dim(" — type a command or 'help'"));
    if (engineIds().length > 0) {
      console.log(chalk.dim(`Engines: ${engineIds().join(", ")}`));
    } else {
      console.log(chalk.yellow("No engines configured. Use: connect <url>"));
    }
    console.log();

    const commands: Record<string, { desc: string; fn: (args: string[]) => Promise<void> }> = {
      help: {
        desc: "Show available commands",
        fn: async () => {
          console.log(chalk.bold("\nCommands:"));
          for (const [cmd, { desc }] of Object.entries(commands)) {
            const alias = Object.entries(aliases).filter(([, v]) => v === cmd).map(([k]) => k);
            const aliasStr = alias.length > 0 ? chalk.dim(` (${alias.join(", ")})`) : "";
            console.log(`  ${chalk.cyan(cmd.padEnd(20))} ${desc}${aliasStr}`);
          }
          console.log();
        },
      },
      connect: {
        desc: "Connect to a database (connect <url>)",
        fn: async (args) => {
          const url = args[0];
          if (!url) {
            console.log(chalk.red("Usage: connect <url>"));
            console.log(chalk.dim("  mysql://user:***@host:port/database?ssl=true"));
            return;
          }

          // Detect engine type from URL scheme
          let type: string;
          let engineConfig: EngineConfig;
          if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
            type = "mysql";
            const parsed = parseMysqlUrl(url.replace(/^mysql2:/, "mysql:"));
            engineConfig = {
              type: "mysql",
              url: url.replace(/^mysql2:/, "mysql:"),
            };
          } else if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
            type = "postgres";
            engineConfig = { type: "postgres", url };
          } else {
            console.log(chalk.red(`Unsupported URL scheme. Use mysql:// or postgresql://`));
            return;
          }

          // Generate an engine ID from host+database
          const parsed = type === "mysql" ? parseMysqlUrl(engineConfig.url!) : null;
          const id = parsed ? `${parsed.host}-${parsed.database}` : `engine-${Date.now()}`;

          config.engines[id] = engineConfig;
          currentEngine = id;
          console.log(chalk.green(`Connected to ${chalk.bold(id)}`));
          if (parsed) {
            console.log(chalk.dim(`  mysql://${parsed.user}:***@${parsed.host}:${parsed.port}/${parsed.database}`));
          }
        },
      },
      engines: {
        desc: "List configured engines",
        fn: async () => {
          if (engineIds().length === 0) {
            console.log(chalk.yellow("No engines. Use: connect <url>"));
            return;
          }
          const table = new Table({
            head: ["ID", "Type", "Host", "Port", "Database", "URL"],
          });
          for (const [id, engine] of Object.entries(config.engines)) {
            const marker = id === currentEngine ? chalk.green(" *") : "";
            if (engine.url) {
              const parsed = parseMysqlUrl(engine.url);
              table.push([id + marker, engine.type, parsed.host, String(parsed.port), parsed.database, chalk.dim(engine.url)]);
            } else {
              table.push([id + marker, engine.type, engine.host ?? "-", String(engine.port ?? 3306), engine.database ?? "-", "-"]);
            }
          }
          console.log(table.toString());
        },
      },
      use: {
        desc: "Switch to engine (use <engineId>)",
        fn: async (args) => {
          const id = args[0];
          if (!id || !config.engines[id]) {
            console.log(chalk.red(`Unknown engine. Available: ${engineIds().join(", ") || "(none)"}`));
            return;
          }
          currentEngine = id;
          console.log(chalk.green(`Switched to ${currentEngine}`));
        },
      },
      status: {
        desc: "Show connection details for current engine",
        fn: async () => {
          const engine = config.engines[currentEngine];
          if (!engine) {
            console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
            return;
          }
          const resolved = resolveMysqlConfig(currentEngine, engine);
          const displayUrl = `mysql://${resolved.user}:***@${resolved.host}:${resolved.port}/${resolved.database}${resolved.ssl ? "?ssl=true" : ""}`;
          console.log();
          console.log(chalk.bold(`  Engine:      `) + chalk.cyan(currentEngine));
          console.log(chalk.bold(`  Type:        `) + engine.type);
          console.log(chalk.bold(`  Host:        `) + `${resolved.host}:${resolved.port}`);
          console.log(chalk.bold(`  User:        `) + resolved.user);
          console.log(chalk.bold(`  Database:    `) + resolved.database);
          console.log(chalk.bold(`  SSL:         `) + (resolved.ssl ? "enabled" : "disabled"));
          console.log(chalk.bold(`  Connection:  `) + chalk.dim(displayUrl));
          console.log();
        },
      },
      "blocking-chains": {
        desc: "Show current blocking chains",
        fn: async () => {
          const engine = config.engines[currentEngine];
          if (!engine) {
            console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
            return;
          }
          if (engine.type !== "mysql") {
            console.log(chalk.red(`blocking-chains not yet supported for ${engine.type}`));
            return;
          }
          try {
            const chains = await getBlockingChainsMySQL(currentEngine, engine);
            if (chains.length === 0) {
              console.log(chalk.green("No blocking chains."));
            } else {
              const table = new Table({
                head: ["Blocking PID", "Blocked PID", "Wait", "Database", "Blocking Query", "Blocked Query"],
                wordWrap: true,
              });
              for (const c of chains) {
                table.push([
                  c.blocking_pid,
                  c.blocked_pid,
                  c.wait_event,
                  c.database_name ?? "-",
                  (c.blocking_query ?? "-").substring(0, 60),
                  (c.blocked_query ?? "-").substring(0, 60),
                ]);
              }
              console.log(table.toString());
              console.log(chalk.yellow(`${chains.length} blocking chain(s)`));
            }
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          }
        },
      },
      quit: {
        desc: "Exit the REPL",
        fn: async () => {
          await closeAllPools();
          console.log(chalk.dim("Bye."));
          process.exit(0);
        },
      },
    };

    // Aliases
    const aliases: Record<string, string> = {
      bc: "blocking-chains",
      ls: "engines",
      s: "status",
      q: "quit",
      exit: "quit",
    };

    while (true) {
      const { default: inquirer } = await import("inquirer");
      const { input } = await inquirer.prompt([
        {
          type: "input",
          name: "input",
          message: chalk.cyan(`ai-dba[${currentEngine || "no-engine"}]>`),
          prefix: "",
        },
      ]);

      const trimmed = input.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      const resolved = aliases[cmd] ?? cmd;
      const command = commands[resolved];

      if (command) {
        await command.fn(args);
      } else {
        console.log(chalk.red(`Unknown command: ${cmd}. Type 'help' for available commands.`));
      }
    }
  });

program.parse();