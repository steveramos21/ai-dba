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
  serial?: number;  // Oracle only: SERIAL# for ALTER SYSTEM KILL SESSION
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

export interface TableSizeInfo {
  name: string;
  schema?: string;
  rows?: number;
  dataSizeBytes?: number;
  indexSizeBytes?: number;
  totalSizeBytes: number;
  dataFreeBytes?: number;
  comment?: string;
}

export interface ExplainResult {
  plan: string;
  format: "json" | "text" | "xml";
  estimatedCost?: number;
  estimatedRows?: number;
  analyzed: boolean;
}

export interface ExplainOptions {
  analyze?: boolean;
}

export interface SlowQueryInfo {
  id: string;
  query: string;
  database?: string;
  executionCount?: number;
  totalExecutionTimeMs: number;
  avgExecutionTimeMs?: number;
  maxExecutionTimeMs?: number;
  rowsExamined?: number;
  rowsReturned?: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface SlowQueryOptions {
  limit?: number;
  minDurationMs?: number;
}

export interface KillResult {
  success: boolean;
  found: boolean;           // true = process existed, false = real error or already gone
  wouldKill?: boolean;      // true for dry-run proposals
  pid: string;              // process ID (Oracle: "SID,SERIAL#")
  engineId: string;
  user?: string;            // process owner
  database?: string;        // database/schema
  duration?: string;        // how long the process has been running
  query?: string;           // truncated query text (500 chars max)
  command?: string;         // exact kill command executed
  killedAt?: string;        // ISO timestamp when killed
  error?: string;           // error message if success=false
  notes?: string;           // e.g., "Process not found — may have terminated independently"
}

export interface ReplicationStatus {
  role: string;             // engine-native: "source" (MySQL), "primary" (PG), etc.
  lagSeconds: number | null;
  status: "healthy" | "degraded" | "down" | "not_configured";
  errorMessage: string | null;
}

export interface ServerVariable {
  name: string;
  value: string;
  description?: string;
}

export interface ServerStatusMetric {
  name: string;
  value: number | string;
  description?: string;
}

export interface HealthCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  value?: string | number;
}

export interface HealthCheckResult {
  status: "healthy" | "warning" | "critical";
  engineId: string;
  engineType: string;
  checks: HealthCheck[];
  timestamp: string;
}

export interface BlockingChain {
  engine_id: string;
  blocking_pid: number;
  blocked_pid: number;
  wait_duration_ms: number | null;
  wait_event: string | null;
  blocking_query: string | null;
  blocked_query: string | null;
  database_name: string | null;
  wait_type: string | null;
  status: string | null;
  host_name: string | null;
  program_name: string | null;
  login_time: string | null;
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

  /** List table sizes (data, index, total) for a database/schema */
  listTableSizes(engineId: string, config: import("./config.js").EngineConfig, database?: string): Promise<TableSizeInfo[]>;

  /** Explain a query's execution plan (EXPLAIN). For MongoDB, `query` is a JSON command document. */
  explainQuery(engineId: string, config: import("./config.js").EngineConfig, query: string, options?: ExplainOptions): Promise<ExplainResult>;

  /** List slow queries from engine internals (performance_schema, pg_stat_statements, etc.) */
  listSlowQueries(engineId: string, config: import("./config.js").EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryInfo[]>;

  /** Show active processes/connections */
  listProcesses(engineId: string, config: import("./config.js").EngineConfig): Promise<ProcessInfo[]>;

  /** Run a raw SQL query (escape hatch for engine-specific queries) */
  query(engineId: string, config: import("./config.js").EngineConfig, sql: string): Promise<QueryResult>;

  /** Get current blocking chains (blocked sessions + their blockers) */
  getBlockingChains(engineId: string, config: import("./config.js").EngineConfig): Promise<BlockingChain[]>;

  /** Kill a database process/session (with dry-run support) */
  killProcess(engineId: string, config: import("./config.js").EngineConfig, pid: string, options?: { dryRun?: boolean }): Promise<KillResult>;

  /** Get replication status for this engine */
  listReplicationStatus(engineId: string, config: import("./config.js").EngineConfig): Promise<ReplicationStatus>;

  /** List server configuration variables (curated subset) */
  listServerVariables(engineId: string, config: import("./config.js").EngineConfig): Promise<ServerVariable[]>;

  /** List server runtime status metrics (curated subset) */
  listServerStatus(engineId: string, config: import("./config.js").EngineConfig): Promise<ServerStatusMetric[]>;

  /** Close all connection pools for this connector */
  closeAllPools(): Promise<void>;
}