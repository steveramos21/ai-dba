import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface EngineConfig {
  type: "mysql" | "postgres" | "sqlserver" | "oracle" | "mongodb";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Optional MongoDB connection URI (overrides individual fields) */
  uri?: string;
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

  // Validate each engine has required fields
  for (const [id, engine] of Object.entries(parsed.engines)) {
    if (!engine.type) {
      throw new Error(`Engine "${id}" missing required "type" field`);
    }
    if (!engine.host) {
      throw new Error(`Engine "${id}" missing required "host" field`);
    }
  }

  return parsed;
}