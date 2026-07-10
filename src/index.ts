#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { loadConfig, parseMysqlUrl, resolveMysqlConfig } from "./config.js";
import type { EngineConfig } from "./config.js";
import type { DatabaseConnector } from "./connector.js";

const program = new Command();

program
  .name("ai-dba")
  .description("AI-DBA: Universal database copilot — diagnostics and operations")
  .version("1.0.0")
  .option("-c, --config <path>", "Path to config.yaml", "config.yaml");

// ─── Helper: get connector by engine type ─────────────────────
function getConnectorForEngineById(engineId: string, config: EngineConfig, connectors: Record<string, DatabaseConnector>): DatabaseConnector {
  const connector = connectors[config.type];
  if (!connector) {
    throw new Error(`Unsupported engine type: ${config.type}`);
  }
  return connector;
}

// ─── Helper: parse URL into engine config ─────────────────────
function parseUrlToEngine(url: string): { id: string; config: EngineConfig; maskedUrl: string } | null {
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
    const config: EngineConfig = { type: "mysql", url: url.replace(/^mysql2:/, "mysql:") };
    const parsed = parseMysqlUrl(config.url!);
    const id = `${parsed.host}-${parsed.database}`;
    const maskedUrl = `mysql://${parsed.user}:***@${parsed.host}:${parsed.port}/${parsed.database}`;
    return { id, config, maskedUrl };
  } else if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    const config: EngineConfig = { type: "postgres", url };
    // Simple mask for display — no custom parsing, pg handles the URL natively
    const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
    // Extract host and db for a readable ID
    try {
      const u = new URL(url);
      const id = `${u.hostname}-${u.pathname.slice(1) || "postgres"}`;
      return { id, config, maskedUrl: masked };
    } catch {
      const id = `postgres-${Date.now()}`;
      return { id, config, maskedUrl: masked };
    }
  } else if (url.startsWith("sqlserver://")) {
    const config: EngineConfig = { type: "sqlserver", url };
    const u = new URL(url);
    const id = `${u.hostname}-${u.pathname.slice(1) || "master"}`;
    const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
    return { id, config, maskedUrl: masked };
  } else if (url.startsWith("oracle://")) {
    const config: EngineConfig = { type: "oracle", url };
    const u = new URL(url);
    const id = `${u.hostname}-${u.pathname.slice(1) || "XE"}`;
    const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
    return { id, config, maskedUrl: masked };
  }
  return null;
}

// ─── Helper: render query results ──────────────────────────────
function renderResult(result: { columns: string[]; rows: Record<string, unknown>[]; affectedRows?: number }): void {
  if (result.rows.length === 0 && result.columns.length === 0) {
    console.log(chalk.yellow("Empty set"));
  } else if (result.affectedRows !== undefined) {
    const table = new Table({ head: result.columns.map(chalk.white) });
    for (const row of result.rows) {
      table.push(result.columns.map((col) => String(row[col] ?? "-")));
    }
    console.log(table.toString());
    console.log(chalk.green(`${result.affectedRows} row(s) affected`));
  } else {
    const table = new Table({ head: result.columns.map(chalk.white) });
    for (const row of result.rows) {
      table.push(result.columns.map((col) => {
        const val = row[col];
        if (val === null) return chalk.dim("NULL");
        if (val instanceof Date) return val.toISOString();
        if (typeof val === "bigint") return val.toString();
        return String(val);
      }));
    }
    console.log(table.toString());
    console.log(chalk.dim(`${result.rows.length} row(s) in set`));
  }
}

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

// ─── blocking-chains ──────────────────────────────────────────
program
  .command("blocking-chains <engineId>")
  .description("Show current blocking chains for an engine")
  .option("--json", "Output raw JSON instead of a table")
  .action(async (engineId: string, cmdOpts: { json?: boolean }) => {
    const { buildConnectorMap, shutdown } = await import("./server.js");
    const opts = program.opts();
    const config = loadConfig(opts.config);
    const engine = config.engines[engineId];

    if (!engine) {
      console.error(chalk.red(`Unknown engine "${engineId}". Available: ${Object.keys(config.engines).join(", ")}`));
      process.exit(1);
    }

    const connectors = buildConnectorMap();
    const connector = connectors[engine.type];
    if (!connector) {
      console.error(chalk.red(`Engine "${engineId}" is type "${engine.type}". No connector registered for this engine type.`));
      process.exit(1);
    }

    try {
      const chains = await connector.getBlockingChains(engineId, engine);

      if (cmdOpts.json) {
        console.log(JSON.stringify({ chains, count: chains.length }, null, 2));
      } else if (chains.length === 0) {
        console.log(chalk.green("No blocking chains found on") + chalk.cyan(` ${engineId}`));
      } else {
        const table = new Table({
          head: [
            chalk.white("Blocked PID"),
            chalk.white("Blocking PID"),
            chalk.white("Wait (ms)"),
            chalk.white("Database"),
            chalk.white("Blocked Query"),
            chalk.white("Status"),
          ],
          colWidths: [14, 14, 14, 16, 40, 16],
          wordWrap: true,
        });

        for (const c of chains) {
          table.push([
            c.blocked_pid,
            c.blocking_pid,
            c.wait_duration_ms ?? "-",
            c.database_name ?? "-",
            (c.blocked_query ?? "-").substring(0, 80),
            c.status ?? "-",
          ]);
        }
        console.log(table.toString());
        console.log(chalk.yellow(`${chains.length} blocking chain(s) on`) + chalk.cyan(` ${engineId}`));
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    } finally {
      await shutdown(connectors);
      process.exit(0);
    }
  });

// ─── connect ──────────────────────────────────────────────────
program
  .command("connect <url>")
  .description("Connect to a database via URL and open REPL")
  .action(async (url: string) => {
    const result = parseUrlToEngine(url);
    if (!result) {
      console.error(chalk.red("Unsupported URL scheme. Use mysql:// or postgresql://"));
      process.exit(1);
    }

    const { id: engineId, config: engineConfig, maskedUrl } = result;
    const { mysqlConnector } = await import("./connectors/mysql.js");
    const { postgresConnector } = await import("./connectors/postgres.js");
    const connectors: Record<string, DatabaseConnector> = { mysql: mysqlConnector, postgres: postgresConnector };

    // Verify connection
    const connector = getConnectorForEngineById(engineId, engineConfig, connectors);
    try {
      await connector.query(engineId, engineConfig, "SELECT 1");
      console.log(chalk.green(`Connected to ${chalk.bold(engineId)}`));
      console.log(chalk.dim(`  ${maskedUrl}`));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }

    // Drop into REPL with this engine
    const config = { engines: { [engineId]: engineConfig } as Record<string, EngineConfig> };

    function getConnectorForEngine(eid: string): DatabaseConnector | null {
      const e = config.engines[eid];
      if (!e) return null;
      return connectors[e.type] ?? null;
    }

    await startRepl(config, engineId, connectors, getConnectorForEngine);
  });

// ─── list-engines ──────────────────────────────────────────────
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
        if (engine.url && engine.type === "mysql") {
          const parsed = parseMysqlUrl(engine.url);
          table.push([chalk.cyan(id), engine.type, parsed.host, String(parsed.port), parsed.database, chalk.dim(engine.url)]);
        } else if (engine.url) {
          // PostgreSQL or other — mask the URL for display, extract via URL constructor
          try {
            const u = new URL(engine.url);
            const masked = engine.url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
            table.push([chalk.cyan(id), engine.type, u.hostname, String(u.port || "5432"), u.pathname.slice(1) || "-", chalk.dim(masked)]);
          } catch {
            table.push([chalk.cyan(id), engine.type, "-", "-", "-", chalk.dim(engine.url)]);
          }
        } else {
          table.push([chalk.cyan(id), engine.type, engine.host ?? "-", String(engine.port ?? (engine.type === "postgres" ? 5432 : engine.type === "sqlserver" ? 1433 : engine.type === "oracle" ? 1521 : 3306)), engine.database ?? "-", "-"]);
        }
      }
      console.log(table.toString());
    }
    process.exit(0);
  });

// ─── REPL logic (shared by repl and connect commands) ─────────
async function startRepl(
  config: { engines: Record<string, EngineConfig> },
  initialEngine: string,
  connectors: Record<string, DatabaseConnector>,
  getConnectorForEngine: (engineId: string) => DatabaseConnector | null,
) {
  const engineIds = () => Object.keys(config.engines);
  let currentEngine = initialEngine;

  console.log(chalk.cyan.bold("AI-DBA REPL") + chalk.dim(" — type 'help' for commands"));
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

        const result = parseUrlToEngine(url);
        if (!result) {
          console.log(chalk.red("Unsupported URL scheme. Use mysql:// or postgresql://"));
          return;
        }

        const { id, config: engineConfig, maskedUrl } = result;
        config.engines[id] = engineConfig;
        currentEngine = id;
        console.log(chalk.green(`Connected to ${chalk.bold(id)}`));
        console.log(chalk.dim(`  ${maskedUrl}`));
      },
    },
    databases: {
      desc: "List databases on the server",
      fn: async () => {
        const engine = config.engines[currentEngine];
        const connector = getConnectorForEngine(currentEngine);
        if (!engine || !connector) {
          console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
          return;
        }
        try {
          const dbs = await connector.listDatabases(currentEngine, engine);
          const table = new Table({ head: [chalk.white("Database")] });
          for (const db of dbs) {
            table.push([db.name]);
          }
          console.log(table.toString());
          console.log(chalk.dim(`${dbs.length} database(s)`));
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      },
    },
    tables: {
      desc: "List tables in current database",
      fn: async (args) => {
        const engine = config.engines[currentEngine];
        const connector = getConnectorForEngine(currentEngine);
        if (!engine || !connector) {
          console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
          return;
        }
        const database = args[0];
        try {
          const tbls = await connector.listTables(currentEngine, engine, database);
          const table = new Table({
            head: [chalk.white("Table"), chalk.white("Rows"), chalk.white("Size"), chalk.white("Engine"), chalk.white("Collation")],
          });
          for (const t of tbls) {
            table.push([
              t.name,
              t.rows?.toLocaleString() ?? "-",
              t.sizeBytes ? `${(t.sizeBytes / 1024).toFixed(1)} KB` : "-",
              t.engine ?? "-",
              t.collation ?? "-",
            ]);
          }
          console.log(table.toString());
          console.log(chalk.dim(`${tbls.length} table(s)`));
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      },
    },
    describe: {
      desc: "Describe table columns (describe <table>)",
      fn: async (args) => {
        const engine = config.engines[currentEngine];
        const connector = getConnectorForEngine(currentEngine);
        if (!engine || !connector) {
          console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
          return;
        }
        const tableName = args[0];
        if (!tableName) {
          console.log(chalk.red("Usage: describe <table>"));
          return;
        }
        const database = args[1]; // optional
        try {
          const cols = await connector.describeTable(currentEngine, engine, tableName, database);
          if (cols.length === 0) {
            console.log(chalk.yellow(`Table "${tableName}" not found or has no columns.`));
            return;
          }
          const table = new Table({
            head: [chalk.white("Column"), chalk.white("Type"), chalk.white("Null"), chalk.white("Key"), chalk.white("Default"), chalk.white("Extra")],
          });
          for (const c of cols) {
            table.push([
              c.name,
              c.type,
              c.nullable ? chalk.dim("YES") : chalk.red("NO"),
              c.isPrimary ? chalk.green("PRI") : "",
              c.defaultValue ?? chalk.dim("NULL"),
              c.isAutoIncrement ? "auto_increment" : "",
            ]);
          }
          console.log(table.toString());
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      },
    },
    indexes: {
      desc: "List indexes on a table (indexes <table>)",
      fn: async (args) => {
        const engine = config.engines[currentEngine];
        const connector = getConnectorForEngine(currentEngine);
        if (!engine || !connector) {
          console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
          return;
        }
        const tableName = args[0];
        if (!tableName) {
          console.log(chalk.red("Usage: indexes <table>"));
          return;
        }
        try {
          const idxs = await connector.listIndexes(currentEngine, engine, tableName);
          if (idxs.length === 0) {
            console.log(chalk.yellow(`No indexes found on "${tableName}".`));
            return;
          }
          const table = new Table({
            head: [chalk.white("Index"), chalk.white("Columns"), chalk.white("Unique"), chalk.white("Type")],
          });
          for (const idx of idxs) {
            table.push([
              idx.isPrimary ? chalk.green(idx.name) : idx.name,
              idx.columns.join(", "),
              idx.isUnique ? chalk.green("YES") : chalk.dim("no"),
              idx.type ?? "-",
            ]);
          }
          console.log(table.toString());
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      },
    },
    processes: {
      desc: "Show active database processes/connections",
      fn: async () => {
        const engine = config.engines[currentEngine];
        const connector = getConnectorForEngine(currentEngine);
        if (!engine || !connector) {
          console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
          return;
        }
        try {
          const procs = await connector.listProcesses(currentEngine, engine);
          const table = new Table({
            head: [chalk.white("PID"), chalk.white("User"), chalk.white("Host"), chalk.white("DB"), chalk.white("Command"), chalk.white("Time"), chalk.white("State")],
            wordWrap: true,
          });
          for (const p of procs) {
            table.push([
              p.pid,
              p.user,
              p.host,
              p.database ?? chalk.dim("-"),
              p.command,
              `${p.time}s`,
              (p.state ?? "-").substring(0, 40),
            ]);
          }
          console.log(table.toString());
          console.log(chalk.dim(`${procs.length} process(es)`));
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
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
          if (engine.url && engine.type === "mysql") {
            const parsed = parseMysqlUrl(engine.url);
            table.push([id + marker, engine.type, parsed.host, String(parsed.port), parsed.database, chalk.dim(engine.url)]);
          } else if (engine.url) {
            try {
              const u = new URL(engine.url);
              const masked = engine.url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
              table.push([id + marker, engine.type, u.hostname, String(u.port || "5432"), u.pathname.slice(1) || "-", chalk.dim(masked)]);
            } catch {
              table.push([id + marker, engine.type, "-", "-", "-", chalk.dim(engine.url)]);
            }
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
        console.log();
        console.log(chalk.bold(`  Engine:      `) + chalk.cyan(currentEngine));
        console.log(chalk.bold(`  Type:        `) + engine.type);
        if (engine.type === "mysql") {
          const resolved = resolveMysqlConfig(currentEngine, engine);
          const displayUrl = `mysql://${resolved.user}:***@${resolved.host}:${resolved.port}/${resolved.database}${resolved.ssl ? "?ssl=true" : ""}`;
          console.log(chalk.bold(`  Host:        `) + `${resolved.host}:${resolved.port}`);
          console.log(chalk.bold(`  User:        `) + resolved.user);
          console.log(chalk.bold(`  Database:    `) + resolved.database);
          console.log(chalk.bold(`  SSL:         `) + (resolved.ssl ? "enabled" : "disabled"));
          console.log(chalk.bold(`  Connection:  `) + chalk.dim(displayUrl));
        } else if (engine.type === "postgres" && engine.url) {
          const maskedUrl = engine.url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
          console.log(chalk.bold(`  Connection:  `) + chalk.dim(maskedUrl));
        } else {
          console.log(chalk.bold(`  Host:        `) + (engine.host ?? "-"));
          console.log(chalk.bold(`  Database:    `) + (engine.database ?? "-"));
        }
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
        const connector = getConnectorForEngine(currentEngine);
        if (!connector) {
          console.log(chalk.red(`No connector registered for engine type "${engine.type}"`));
          return;
        }
        try {
          const chains = await connector.getBlockingChains(currentEngine, engine);
          if (chains.length === 0) {
            console.log(chalk.green("No blocking chains."));
          } else {
            const table = new Table({
              head: ["Blocked PID", "Blocking PID", "Wait (ms)", "Database", "Blocked Query", "Status"],
              wordWrap: true,
            });
            for (const c of chains) {
              table.push([
                c.blocked_pid,
                c.blocking_pid,
                c.wait_duration_ms ?? "-",
                c.database_name ?? "-",
                (c.blocked_query ?? "-").substring(0, 60),
                c.status ?? "-",
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
    sql: {
      desc: "Run a raw SQL query (escape hatch)",
      fn: async (args) => {
        const engine = config.engines[currentEngine];
        const connector = getConnectorForEngine(currentEngine);
        if (!engine || !connector) {
          console.log(chalk.red("No engine selected. Use: connect <url> or use <engineId>"));
          return;
        }
        const sql = args.join(" ");
        if (!sql) {
          console.log(chalk.red("Usage: sql <statement>"));
          console.log(chalk.dim("  sql SHOW DATABASES"));
          console.log(chalk.dim("  sql SELECT * FROM users LIMIT 10"));
          console.log(chalk.dim(""));
          console.log(chalk.dim("Note: prefer standard commands (databases, tables, describe, etc.)"));
          return;
        }
        try {
          const result = await connector.query(currentEngine, engine, sql);
          renderResult(result);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      },
    },
    quit: {
      desc: "Exit the REPL",
      fn: async () => {
        for (const connector of Object.values(connectors)) {
          await connector.closeAllPools();
        }
        console.log(chalk.dim("Bye."));
        process.exit(0);
      },
    },
  };

  // Aliases
  const aliases: Record<string, string> = {
    bc: "blocking-chains",
    ls: "engines",
    db: "databases",
    dt: "tables",
    desc: "describe",
    idx: "indexes",
    ps: "processes",
    s: "status",
    q: "quit",
    exit: "quit",
  };

  // SQL keywords that auto-route to the sql command
  const sqlKeywords = ["select", "show", "describe", "desc", "explain", "insert", "update", "delete", "create", "alter", "drop", "truncate", "with"];

  while (true) {
    const { default: inquirer } = await import("inquirer");
    const { input } = await inquirer.prompt([
      {
        type: "input",
        name: "input",
        message: chalk.cyan("ai-dba[" + (currentEngine || "no-engine") + "]>"),
        prefix: "",
      },
    ]);

    const trimmed = input.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Resolve aliases, then check if it's a REPL command, then SQL keyword
    const aliased = aliases[cmd];
    const resolved = aliased ?? (commands[cmd] ? cmd : (sqlKeywords.includes(cmd) ? "sql" : cmd));
    const command = commands[resolved];

    // For sql command via auto-route, pass the entire input as args
    const commandArgs = resolved === "sql" && cmd !== "sql" ? [trimmed] : args;

    if (command) {
      await command.fn(commandArgs);
    } else {
      console.log(chalk.red(`Unknown command: ${cmd}. Type 'help' for available commands.`));
    }
  }
}

// ─── repl ─────────────────────────────────────────────────────
program
  .command("repl")
  .description("Interactive REPL for database diagnostics")
  .action(async () => {
    const { mysqlConnector } = await import("./connectors/mysql.js");
    const { postgresConnector } = await import("./connectors/postgres.js");
    const opts = program.opts();

    // Load config if it exists, otherwise start with empty engines
    let config: { engines: Record<string, EngineConfig> };
    try {
      config = loadConfig(opts.config);
    } catch {
      config = { engines: {} };
    }

    const connectors: Record<string, DatabaseConnector> = {
      mysql: mysqlConnector,
      postgres: postgresConnector,
    };

    const engineIds = () => Object.keys(config.engines);
    const initialEngine = engineIds()[0] ?? "";

    function getConnectorForEngine(engineId: string): DatabaseConnector | null {
      const engine = config.engines[engineId];
      if (!engine) return null;
      return connectors[engine.type] ?? null;
    }

    await startRepl(config, initialEngine, connectors, getConnectorForEngine);
  });

program.parse();