import { Connection, Request, type ConnectionConfiguration } from "tedious";
import type { EngineConfig } from "../config.js";
import type {
  DatabaseConnector,
  DatabaseInfo,
  TableInfo,
  TableSizeInfo,
  ColumnInfo,
  IndexInfo,
  ProcessInfo,
  QueryResult,
  BlockingChain,
  ExplainResult,
  ExplainOptions,
  SlowQueryInfo,
  SlowQueryOptions,
  KillResult,
  ReplicationStatus,
  ServerVariable,
  ServerStatusMetric,
} from "../connector.js";
import { writeAuditEntry } from "../audit.js";

/**
 * Parse a sqlserver:// connection URL into tedious config options.
 * Format: sqlserver://user:password@host:port/database
 */
export function parseSqlServerUrl(url: string): {
  server: string;
  port: number;
  userName: string;
  password: string;
  database: string;
} {
  try {
    const parsed = new URL(url);
    return {
      server: parsed.hostname || "localhost",
      port: parseInt(parsed.port, 10) || 1433,
      userName: decodeURIComponent(parsed.username || "sa"),
      password: decodeURIComponent(parsed.password || ""),
      database: decodeURIComponent(parsed.pathname.slice(1)),
    };
  } catch {
    throw new Error(
      `Invalid SQL Server URL: ${url}\n` +
      `Expected: sqlserver://user:password@host:port/database`
    );
  }
}

/** Promise-based wrapper around a single tedious Connection */
class TediousConnection {
  private conn: Connection;

  constructor(config: ConnectionConfiguration) {
    this.conn = new Connection(config);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.on("error", (err: Error) => reject(err));
      this.conn.on("connect", (err: Error | undefined) => {
        if (err) reject(err);
        else resolve();
      });
      this.conn.connect();
    });
  }

  /** Execute a SQL query, return rows as array of plain objects */
  execSql(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let columns: string[] = [];

      const request = new Request(sql, (err) => {
        if (err) reject(err);
        else resolve({ columns, rows });
      });

      // tedious Request extends EventEmitter but its .d.ts overloads don't expose
      // "columnMetadata"/"row" as typed events — cast through any to subscribe
      (request as any).on("columnMetadata", (metadata: any[]) => {
        columns = metadata.map((m: any) => m.colName);
      });

      (request as any).on("row", (row: any[]) => {
        const record: Record<string, unknown> = {};
        for (const col of row) {
          record[col.metadata.colName] = col.value;
        }
        rows.push(record);
      });

      this.conn.execSql(request);
    });
  }

  close(): void {
    this.conn.close();
  }
}

export class SqlServerConnector implements DatabaseConnector {
  private connections: Map<string, TediousConnection> = new Map();

  private async getConnection(engineId: string, config: EngineConfig): Promise<TediousConnection> {
    let conn = this.connections.get(engineId);
    if (!conn) {
      const cfg = config.url
        ? parseSqlServerUrl(config.url)
        : {
            server: config.host || "localhost",
            port: config.port || 1433,
            userName: config.user || "sa",
            password: config.password || "",
            database: config.database || "",
          };

      conn = new TediousConnection({
        server: cfg.server,
        authentication: {
          type: "default",
          options: {
            userName: cfg.userName,
            password: cfg.password,
          },
        },
        options: {
          port: cfg.port,
          database: cfg.database,
          trustServerCertificate: true,
          encrypt: false,
        },
      });

      await conn.connect();
      this.connections.set(engineId, conn);
    }
    return conn;
  }

  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const conn = await this.getConnection(engineId, config);
    const { rows } = await conn.execSql(
      "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name"
    );
    return rows.map((row: any) => ({ name: row.name }));
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const conn = await this.getConnection(engineId, config);
    const dbFilter = database
      ? `TABLE_SCHEMA = '${database.replace(/'/g, "''")}'`
      : "1 = 1";
    const { rows } = await conn.execSql(
      `SELECT TABLE_NAME as name, TABLE_SCHEMA as schema_name FROM INFORMATION_SCHEMA.TABLES WHERE ${dbFilter} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`
    );
    return rows.map((row: any) => ({
      name: row.name,
      schema: row.schema_name,
    }));
  }

  async describeTable(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<ColumnInfo[]> {
    const conn = await this.getConnection(engineId, config);
    let schema = "dbo";
    let table = tableName;
    if (tableName.includes(".")) {
      const parts = tableName.split(".");
      schema = parts[0];
      table = parts[1];
    }
    if (database) schema = database;

    const sSchema = schema.replace(/'/g, "''");
    const sTable = table.replace(/'/g, "''");

    const { rows } = await conn.execSql(
      `SELECT
        COLUMN_NAME as name,
        DATA_TYPE as type,
        IS_NULLABLE as nullable,
        COLUMN_DEFAULT as default_value,
        COLUMNPROPERTY(OBJECT_ID(QUOTENAME('${sSchema}') + '.' + QUOTENAME('${sTable}')), COLUMN_NAME, 'IsIdentity') as is_identity
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${sSchema}' AND TABLE_NAME = '${sTable}'
      ORDER BY ORDINAL_POSITION`
    );

    // Get PK info
    const pkResult = await conn.execSql(
      `SELECT kcu.COLUMN_NAME as column_name
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_SCHEMA = '${sSchema}' AND tc.TABLE_NAME = '${sTable}'`
    );
    const pkColumns = new Set(pkResult.rows.map((r: any) => r.column_name));

    return rows.map((row: any) => ({
      name: row.name,
      type: row.type,
      nullable: row.nullable === "YES",
      isPrimary: pkColumns.has(row.name),
      isAutoIncrement: Boolean(row.is_identity),
      defaultValue: row.default_value ?? null,
    }));
  }

  async listIndexes(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<IndexInfo[]> {
    const conn = await this.getConnection(engineId, config);
    let schema = "dbo";
    let table = tableName;
    if (tableName.includes(".")) {
      const parts = tableName.split(".");
      schema = parts[0];
      table = parts[1];
    }
    if (database) schema = database;

    const sSchema = schema.replace(/'/g, "''");
    const sTable = table.replace(/'/g, "''");

    const { rows } = await conn.execSql(
      `SELECT
        i.name as index_name,
        i.type_desc as index_type,
        i.is_unique,
        i.is_primary_key,
        STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) as columns_csv
      FROM sys.indexes i
      JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      JOIN sys.tables t ON i.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${sSchema}' AND t.name = '${sTable}'
      GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
      ORDER BY i.name`
    );

    return rows.map((row: any) => ({
      name: row.index_name,
      table,
      columns: row.columns_csv ? row.columns_csv.split(",") : [],
      isUnique: Boolean(row.is_unique),
      isPrimary: Boolean(row.is_primary_key),
      type: row.index_type,
    }));
  }

  async listTableSizes(engineId: string, config: EngineConfig, database?: string): Promise<TableSizeInfo[]> {
    const conn = await this.getConnection(engineId, config);
    // Validate identifier BEFORE interpolation to prevent SQL injection
    if (database && !/^[A-Za-z_][A-Za-z0-9_#$]*$/.test(database)) {
      throw new Error(`Invalid schema name: "${database}" — only alphanumeric characters, underscores, #, and $ are allowed.`);
    }
    const schemaFilter = database
      ? `AND s.name = N'${database.replace(/'/g, "''")}'`
      : "";
    const { rows } = await conn.execSql(
      `SELECT
        t.name AS table_name,
        s.name AS schema_name,
        SUM(p.rows) AS row_count,
        SUM(a.total_pages) * 8192 AS total_size,
        SUM(a.used_pages) * 8192 AS used_size,
        SUM(CASE WHEN a.type = 1 THEN a.data_pages ELSE 0 END) * 8192 AS data_size,
        SUM(CASE WHEN a.type IN (1,3) THEN a.used_pages - a.data_pages ELSE a.used_pages END) * 8192 AS index_size
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.partitions p ON t.object_id = p.object_id
      JOIN sys.allocation_units a ON p.partition_id = a.container_id
      WHERE t.is_ms_shipped = 0 ${schemaFilter}
      GROUP BY t.name, s.name
      ORDER BY SUM(a.total_pages) DESC`
    );
    return rows.map((row: any) => ({
      name: row.table_name,
      schema: row.schema_name,
      rows: Number(row.row_count),
      dataSizeBytes: Number(row.data_size ?? 0),
      indexSizeBytes: Number(row.index_size ?? 0),
      totalSizeBytes: Number(row.total_size ?? 0),
    }));
  }

  async explainQuery(engineId: string, config: EngineConfig, query: string, _options?: ExplainOptions): Promise<ExplainResult> {
    const conn = await this.getConnection(engineId, config);
    // SQL Server: SET SHOWPLAN_XML ON, run query (returns XML plan), then SET OFF
    await conn.execSql("SET SHOWPLAN_XML ON");
    try {
      const { rows } = await conn.execSql(query);
      // SHOWPLAN_XML returns one row with an XML column named "Microsoft SQL Server XML Showplan"
      const plan = rows[0]?.["Microsoft SQL Server XML Showplan"] ?? JSON.stringify(rows, null, 2);
      return { plan: String(plan), format: "xml", analyzed: false };
    } finally {
      await conn.execSql("SET SHOWPLAN_XML OFF");
    }
  }

  async listSlowQueries(engineId: string, config: EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryInfo[]> {
    const limit = options?.limit ?? 10;
    const minDurationMs = options?.minDurationMs ?? 1000;
    const minDurationUs = Math.round(minDurationMs * 1000);
    const conn = await this.getConnection(engineId, config);
    try {
      // SQL Server: sys.dm_exec_query_stats — total_elapsed_time is in microseconds
      const { rows } = await conn.execSql(
        `SELECT TOP ${limit}
          qs.sql_handle          AS sql_handle,
          qs.plan_handle         AS plan_handle,
          qs.execution_count      AS exec_count,
          qs.total_elapsed_time   AS total_time_us,
          qs.total_elapsed_time / NULLIF(qs.execution_count, 0) AS avg_time_us,
          qs.max_elapsed_time     AS max_time_us,
          qs.total_rows           AS rows_returned,
          qs.total_logical_reads  AS logical_reads,
          st.text                 AS query_text,
          DB_NAME(qs.database_id) AS db_name
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
        WHERE qs.total_elapsed_time >= ${minDurationUs}
        ORDER BY qs.total_elapsed_time DESC`
      );
      return rows.map((row: any, i: number) => ({
        id: `sqlserver-${i}`,
        query: (row.query_text ?? "").substring(0, 2000),
        database: row.db_name ?? undefined,
        executionCount: Number(row.exec_count),
        totalExecutionTimeMs: Math.round(Number(row.total_time_us) / 1000),
        avgExecutionTimeMs: row.avg_time_us != null ? Math.round(Number(row.avg_time_us) / 1000) : undefined,
        maxExecutionTimeMs: Math.round(Number(row.max_time_us) / 1000),
        rowsReturned: Number(row.rows_returned) || undefined,
      }));
    } catch {
      // sys.dm_exec_query_stats requires VIEW SERVER STATE — return empty if denied
      return [];
    }
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const conn = await this.getConnection(engineId, config);
    const { rows } = await conn.execSql(
      `SELECT
        r.session_id as pid,
        s.login_name as user_name,
        s.host_name as host,
        DB_NAME(s.database_id) as database_name,
        r.command as command,
        r.status as status,
        r.total_elapsed_time AS time,
        st.text as query
      FROM sys.dm_exec_requests r
      JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
      OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
      WHERE r.session_id <> @@SPID AND r.session_id >= 50 AND s.is_user_process = 1`
    );

    return rows.map((row: any) => ({
      pid: row.pid,
      user: row.user_name ?? "",
      host: row.host ?? "",
      database: row.database_name ?? null,
      command: row.command ?? "query",
      time: row.time ?? 0,
      state: row.status ?? null,
      query: row.query ?? null,
    }));
  }

  async query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult> {
    const sqlUpper = sql.trim().toUpperCase();
    if (!(
      sqlUpper.startsWith("SELECT") ||
      sqlUpper.startsWith("WITH") ||
      sqlUpper.startsWith("EXPLAIN") ||
      sqlUpper.startsWith("DESCRIBE") ||
      sqlUpper.startsWith("DESC")
    )) {
      throw new Error("Only read-only queries (SELECT, WITH, EXPLAIN, DESCRIBE, DESC) are allowed for now.");
    }

    const conn = await this.getConnection(engineId, config);
    const { columns, rows } = await conn.execSql(sql);
    return { columns, rows };
  }

  async getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]> {
    const conn = await this.getConnection(engineId, config);
    const { rows } = await conn.execSql(
      `SELECT
        r.blocking_session_id  AS blocking_pid,
        r.session_id           AS blocked_pid,
        r.total_elapsed_time AS wait_duration_ms,
        r.wait_type            AS wait_event,
        blocking_st.text       AS blocking_query,
        blocked_st.text        AS blocked_query,
        DB_NAME(r.database_id) AS database_name,
        r.wait_type            AS wait_type,
        r.status               AS status,
        s.host_name            AS host_name,
        s.program_name         AS program_name,
        NULL                   AS login_time
      FROM sys.dm_exec_requests r
      JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
      LEFT JOIN sys.dm_exec_requests blocking_r ON blocking_r.session_id = r.blocking_session_id
      OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) blocked_st
      OUTER APPLY sys.dm_exec_sql_text(blocking_r.sql_handle) blocking_st
      WHERE r.blocking_session_id <> 0`
    );

    return rows.map((row: any) => ({
      engine_id: engineId,
      blocking_pid: row.blocking_pid,
      blocked_pid: row.blocked_pid,
      wait_duration_ms: row.wait_duration_ms ?? null,
      wait_event: row.wait_event ?? null,
      blocking_query: row.blocking_query ?? null,
      blocked_query: row.blocked_query ?? null,
      database_name: row.database_name ?? null,
      wait_type: row.wait_type ?? null,
      status: row.status ?? null,
      host_name: row.host_name ?? null,
      program_name: row.program_name ?? null,
      login_time: row.login_time ?? null,
    }));
  }

  async closeAllPools(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }

  // ─── Sprint 9: Write operations + server diagnostics ───

  async killProcess(engineId: string, config: EngineConfig, pid: string, options?: { dryRun?: boolean }): Promise<KillResult> {
    const dryRun = options?.dryRun ?? false;
    const pidNum = parseInt(pid, 10);

    if (isNaN(pidNum) || pidNum <= 0) {
      return { success: false, found: false, pid, engineId, error: `Invalid PID: "${pid}" — expected a positive integer` };
    }

    if (!config.allowWriteOps) {
      return { success: false, found: false, pid, engineId, error: `Write operations disabled for engine "${engineId}". Set allowWriteOps: true in config.yaml.` };
    }

    const conn = await this.getConnection(engineId, config);
    try {
      // Look up the process
      const { rows } = await conn.execSql(
        `SELECT r.session_id as pid, s.login_name as user_name, s.host_name as host,
                DB_NAME(s.database_id) as database_name, r.status as status,
                r.total_elapsed_time as time, st.text as query
         FROM sys.dm_exec_requests r
         JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
         OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
         WHERE r.session_id = ${pidNum}`
      );

      const proc = rows[0] as any;
      const command = `KILL ${pidNum}`;
      const queryTrunc = proc?.query ? (proc.query as string).substring(0, 500) : undefined;
      const durationStr = proc ? `${proc.time ?? 0}ms` : undefined;

      // Process not found
      if (!proc) {
        if (dryRun) {
          return { success: false, found: false, wouldKill: true, pid, engineId, command, notes: "Process not found — may have terminated independently" };
        }
        // Try to kill anyway — check error to distinguish "already gone" from real errors
        try {
          await conn.execSql(`KILL ${pidNum}`);
        } catch (e: any) {
          const msg = e.message ?? String(e);
          if (msg.includes("not a valid process") || msg.includes("SPID") || msg.includes("not found")) {
            return { success: true, found: false, pid, engineId, command, killedAt: new Date().toISOString(), notes: "Process not found — may have terminated independently" };
          }
          return { success: false, found: false, pid, engineId, command, error: msg };
        }
        return { success: true, found: false, pid, engineId, command, killedAt: new Date().toISOString(), notes: "Process not found — may have terminated independently" };
      }

      // Dry-run: return proposal
      if (dryRun) {
        return {
          success: false, found: true, wouldKill: true, pid, engineId,
          user: proc.user_name, database: proc.database_name ?? undefined,
          duration: durationStr, query: queryTrunc, command,
        };
      }

      // Execute the kill
      try {
        await conn.execSql(`KILL ${pidNum}`);
        const killedAt = new Date().toISOString();

        writeAuditEntry({
          timestamp: killedAt, action: "kill-process", engineId, pid,
          user: proc.user_name, database: proc.database_name ?? undefined,
          duration: durationStr, query: queryTrunc, command,
          success: true, killedAt,
        });

        return { success: true, found: true, pid, engineId, user: proc.user_name, database: proc.database_name ?? undefined, duration: durationStr, query: queryTrunc, command, killedAt };
      } catch (e: any) {
        const error = e.message ?? String(e);
        writeAuditEntry({
          timestamp: new Date().toISOString(), action: "kill-process", engineId, pid,
          user: proc.user_name, database: proc.database_name ?? undefined,
          duration: durationStr, query: queryTrunc, command,
          success: false, error,
        });
        return { success: false, found: true, pid, engineId, user: proc.user_name, database: proc.database_name ?? undefined, duration: durationStr, query: queryTrunc, command, error };
      }
    } finally {
      // Don't close — connection is reused
    }
  }

  async listReplicationStatus(engineId: string, config: EngineConfig): Promise<ReplicationStatus> {
    const conn = await this.getConnection(engineId, config);
    try {
      // Check AlwaysOn Availability Groups
      const { rows } = await conn.execSql(
        `SELECT
           ars.role_desc AS role,
           ars.synchronization_health_desc AS health,
           DATEDIFF(SECOND, ars.last_connect_time, GETUTCDATE()) AS lag_seconds
         FROM sys.dm_hadr_availability_replica_states ars
         JOIN sys.availability_replicas ar ON ars.replica_id = ar.replica_id`
      );

      if (rows.length > 0) {
        const r = rows[0] as any;
        const role = (r.role as string)?.toLowerCase() ?? "none";
        const health = r.health as string;
        const lag = r.lag_seconds != null ? Number(r.lag_seconds) : null;

        if (health === "NOT_HEALTHY") {
          return { role, lagSeconds: lag, status: "down", errorMessage: "Availability group not healthy" };
        }
        if (lag != null && lag > 60) {
          return { role, lagSeconds: lag, status: "degraded", errorMessage: null };
        }
        return { role, lagSeconds: lag, status: "healthy", errorMessage: null };
      }

      return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
    } catch {
      // AG views not available or no permission
      return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
    }
  }

  async listServerVariables(engineId: string, config: EngineConfig): Promise<ServerVariable[]> {
    const conn = await this.getConnection(engineId, config);
    const { rows } = await conn.execSql(
      `SELECT name, value_in_use AS value, description
       FROM sys.configurations
       WHERE name IN (
         'max degree of parallelism', 'cost threshold for parallelism',
         'max server memory (MB)', 'min server memory (MB)',
         'max worker threads', 'network packet size (B)',
         'user connections', 'locks', 'open objects',
         'remote access', 'remote login timeout (s)', 'remote query timeout (s)',
         'default language', 'fill factor (%)',
         'index create memory (KB)', 'min memory per query (KB)',
         'query wait (s)', 'query governor cost limit',
         'max text repl size (B)', 'media retention (days)',
         'recovery interval (min)', 'nested triggers',
         'affinity mask', 'lightweight pooling', 'priority boost',
         'transform noise words', 'two digit year cutoff',
         'xp_cmdshell', 'clr enabled', 'cross db ownership chaining',
         'remote proc trans', 'Ole Automation Procedures',
         'Ad Hoc Distributed Queries', 'show advanced options'
       )
       ORDER BY name`
    );
    return rows.map((row: any) => ({
      name: row.name,
      value: String(row.value ?? ""),
      description: row.description ?? undefined,
    }));
  }

  async listServerStatus(engineId: string, config: EngineConfig): Promise<ServerStatusMetric[]> {
    const conn = await this.getConnection(engineId, config);
    const { rows } = await conn.execSql(
      `SELECT
         @@CONNECTIONS AS total_connections,
         @@MAX_CONNECTIONS AS max_connections,
         @@TOTAL_READ AS total_read,
         @@TOTAL_WRITE AS total_write,
         @@TOTAL_ERRORS AS total_errors,
         @@PACK_RECEIVED AS pack_received,
         @@PACK_SENT AS pack_sent,
         @@CPU_BUSY AS cpu_busy,
         @@IO_BUSY AS io_busy,
         @@IDLE AS idle_time,
         @@TIMETICKS AS time_ticks,
         (SELECT COUNT(*) FROM sys.dm_exec_connections) AS active_connections,
         (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS user_sessions,
         (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id >= 50) AS active_requests,
         (SELECT COUNT(*) FROM sys.dm_tran_locks WHERE request_status = 'GRANT') AS granted_locks,
         (SELECT COUNT(*) FROM sys.dm_tran_locks WHERE request_status = 'WAIT') AS waiting_locks`
    );
    if (rows.length === 0) return [];
    const r = rows[0] as any;
    return [
      { name: "total_connections", value: Number(r.total_connections ?? 0) },
      { name: "max_connections", value: Number(r.max_connections ?? 0) },
      { name: "active_connections", value: Number(r.active_connections ?? 0) },
      { name: "user_sessions", value: Number(r.user_sessions ?? 0) },
      { name: "active_requests", value: Number(r.active_requests ?? 0) },
      { name: "granted_locks", value: Number(r.granted_locks ?? 0) },
      { name: "waiting_locks", value: Number(r.waiting_locks ?? 0) },
      { name: "total_read", value: Number(r.total_read ?? 0) },
      { name: "total_write", value: Number(r.total_write ?? 0) },
      { name: "total_errors", value: Number(r.total_errors ?? 0) },
      { name: "cpu_busy", value: Number(r.cpu_busy ?? 0) },
      { name: "io_busy", value: Number(r.io_busy ?? 0) },
      { name: "idle_time", value: Number(r.idle_time ?? 0) },
    ];
  }
}

export const sqlserverConnector = new SqlServerConnector();