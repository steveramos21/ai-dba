/**
 * Standard database-agnostic command interface.
 * Each engine connector implements these to provide consistent REPL commands.
 */
export interface DatabaseInfo {
  name: string;
  charset?: string;
  collation?: string;
  sizeBytes?: number;
  tableCount?: number;
}

export interface TableInfo {
  name: string;
  schema?: string;
  rows?: number;
  sizeBytes?: number;
  engine?: string;
  collation?: string;
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimary: boolean;
  isAutoIncrement: boolean;
  comment?: string;
}

export interface IndexInfo {
  name: string;
  table: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  type?: string;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  host: string;
  database: string | null;
  command: string;
  time: number;
  state: string | null;
  query: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
}

/**
 * Connector interface — one per database engine type.
 * The REPL routes standard commands to the active engine's connector.
 */
export interface DatabaseConnector {
  /** List databases/schemas on the server */
  listDatabases(engineId: string, config: import("./config.js").EngineConfig): Promise<DatabaseInfo[]>;

  /** List tables in a database */
  listTables(engineId: string, config: import("./config.js").EngineConfig, database?: string): Promise<TableInfo[]>;

  /** Describe columns of a table */
  describeTable(engineId: string, config: import("./config.js").EngineConfig, table: string, database?: string): Promise<ColumnInfo[]>;

  /** List indexes on a table */
  listIndexes(engineId: string, config: import("./config.js").EngineConfig, table: string, database?: string): Promise<IndexInfo[]>;

  /** Show active processes/connections */
  listProcesses(engineId: string, config: import("./config.js").EngineConfig): Promise<ProcessInfo[]>;

  /** Run a raw SQL query (escape hatch for engine-specific queries) */
  query(engineId: string, config: import("./config.js").EngineConfig, sql: string): Promise<QueryResult>;

  /** Close all connection pools for this connector */
  closeAllPools(): Promise<void>;
}