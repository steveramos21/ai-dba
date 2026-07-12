import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface EngineConfig {
  type: "mysql" | "postgres" | "sqlserver" | "oracle" | "mongodb";
  /**
   * Connection URL (preferred). Takes priority over individual fields.
   * Examples:
   *   mysql://user:pass@host:3306/dbname?ssl=true
   *   mysql://user:pass@host:3306/dbname
   */
  url?: string;
  /** @deprecated Use url instead. Individual fields are overridden when url is set. */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Additional mysql2 pool options passed through */
  ssl?: Record<string, unknown>;
  /** Connection limit (default: 5) */
  connectionLimit?: number;
  /** Allow write operations (kill-process). Default: false. */
  allowWriteOps?: boolean;
}

export interface AiDbaConfig {
  engines: Record<string, EngineConfig>;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config.yaml");

export function loadConfig(configPath?: string): AiDbaConfig {
  const resolved = configPath ?? DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = yaml.load(raw) as AiDbaConfig | undefined;

  if (!parsed || !parsed.engines || typeof parsed.engines !== "object") {
    throw new Error(`Invalid config: expected top-level "engines" mapping`);
  }

  // Validate each engine has either url or host
  for (const [id, engine] of Object.entries(parsed.engines)) {
    if (!engine.type) {
      throw new Error(`Engine "${id}" missing required "type" field`);
    }
    if (!engine.url && !engine.host) {
      throw new Error(
        `Engine "${id}" requires either "url" or "host" field. ` +
        `Examples:\n` +
        `  url: mysql://user:pass@host:3306/dbname\n` +
        `  url: mysql://user:pass@host:3306/dbname?ssl=true\n` +
        `  host: 127.0.0.1  (with port, user, password, database)`
      );
    }
  }

  return parsed;
}

/**
 * Parse a MySQL connection URL into mysql2 pool options.
 * Supports: mysql://user:pass@host:port/database?ssl=true&other=params
 */
export function parseMysqlUrl(url: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: Record<string, unknown> | true;
  extra: Record<string, string>;
} {
  try {
    const parsed = new URL(url);

    const host = parsed.hostname || "localhost";
    const port = parseInt(parsed.port, 10) || 3306;
    const user = decodeURIComponent(parsed.username || "root");
    const password = decodeURIComponent(parsed.password || "");
    const database = decodeURIComponent(parsed.pathname.slice(1)); // remove leading /

    // Parse query params
    const extra: Record<string, string> = {};
    let ssl: Record<string, unknown> | true | undefined;
    for (const [key, value] of parsed.searchParams) {
      if (key === "ssl") {
        // ssl=true, ssl=1, ssl=yes all enable SSL
        ssl = (value === "true" || value === "1" || value === "yes" || value === "")
          ? true
          : JSON.parse(value); // allows ssl={"rejectUnauthorized":false}
      } else {
        extra[key] = value;
      }
    }

    return { host, port, user, password, database, ssl, extra };
  } catch (err) {
    throw new Error(
      `Invalid connection URL: ${url}\n` +
      `Expected format: mysql://user:pass@host:port/database?ssl=true`
    );
  }
}

/**
 * Resolve an EngineConfig into mysql2-compatible pool options.
 * If url is set, it takes priority over individual fields.
 */
export function resolveMysqlConfig(engineId: string, config: EngineConfig): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: Record<string, unknown> | true;
  waitForConnections: boolean;
  connectionLimit: number;
  queueLimit: number;
  enableKeepAlive: boolean;
} {
  if (config.url) {
    const { extra, ...parsed } = parseMysqlUrl(config.url);
    return {
      ...parsed,
      waitForConnections: true,
      connectionLimit: config.connectionLimit ?? 5,
      queueLimit: 0,
      enableKeepAlive: true,
    };
  }

  // Fall back to individual fields
  if (!config.host) {
    throw new Error(`Engine "${engineId}" has no url and no host configured`);
  }

  return {
    host: config.host,
    port: config.port ?? 3306,
    user: config.user ?? "root",
    password: config.password ?? "",
    database: config.database ?? "",
    ssl: config.ssl,
    waitForConnections: true,
    connectionLimit: config.connectionLimit ?? 5,
    queueLimit: 0,
    enableKeepAlive: true,
  };
}