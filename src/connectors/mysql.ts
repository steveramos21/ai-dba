import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { resolveMysqlConfig } from "../config.js";
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

export class MySQLConnector implements DatabaseConnector {
  private pools: Map<string, Pool> = new Map();

  getPool(engineId: string, config: EngineConfig): Pool {
    let pool = this.pools.get(engineId);
    if (!pool) {
      if (config.url) {
        pool = mysql.createPool(config.url);
      } else {
        pool = mysql.createPool({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
          ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        });
      }
      this.pools.set(engineId, pool);
    }
    return pool;
  }

  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT SCHEMA_NAME as name, DEFAULT_CHARACTER_SET_NAME as charset, DEFAULT_COLLATION_NAME as collation FROM INFORMATION_SCHEMA.SCHEMATA"
      );
      return rows.map((row) => ({
        name: row.name,
        charset: row.charset,
        collation: row.collation,
      }));
    } finally {
      connection.release();
    }
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const resolved = config.url ? resolveMysqlConfig(engineId, config) : undefined;
      const dbName = database || config.database || resolved?.database;
      if (!dbName) throw new Error(`No database specified for engine "${engineId}". Pass a database parameter or configure one in config.yaml.`);
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT TABLE_NAME as name, TABLE_ROWS as `rows`, DATA_LENGTH as sizeBytes, ENGINE as engine, TABLE_COLLATION as collation FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
        [dbName]
      );
      return rows.map((row) => ({
        name: row.name,
        rows: row.rows,
        sizeBytes: row.sizeBytes,
        engine: row.engine,
        collation: row.collation,
      }));
    } finally {
      connection.release();
    }
  }

  async describeTable(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<ColumnInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const resolved = config.url ? resolveMysqlConfig(engineId, config) : undefined;
      const dbName = database || config.database || resolved?.database;
      if (!dbName) throw new Error(`No database specified for engine "${engineId}". Pass a database parameter or configure one in config.yaml.`);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
          COLUMN_NAME as name,
          COLUMN_TYPE as type,
          IS_NULLABLE as nullable,
          COLUMN_KEY as \`key\`,
          COLUMN_DEFAULT as default_value,
          EXTRA as extra,
          COLUMN_COMMENT as comment
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [dbName, tableName]
      );
      return rows.map((row: any) => ({
        name: row.name,
        type: row.type,
        nullable: row.nullable === "YES",
        isPrimary: row.key === "PRI",
        isAutoIncrement: (row.extra as string)?.includes("auto_increment") ?? false,
        defaultValue: row.default_value,
        comment: row.comment,
      }));
    } finally {
      connection.release();
    }
  }

  async listIndexes(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<IndexInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const resolved = config.url ? resolveMysqlConfig(engineId, config) : undefined;
      const dbName = database || config.database || resolved?.database;
      if (!dbName) throw new Error(`No database specified for engine "${engineId}". Pass a database parameter or configure one in config.yaml.`);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
          s.INDEX_NAME as name,
          s.TABLE_NAME as table_name,
          GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX) as columns_csv,
          s.NON_UNIQUE as non_unique,
          s.INDEX_TYPE as index_type
        FROM INFORMATION_SCHEMA.STATISTICS s
        WHERE s.TABLE_SCHEMA = ? AND s.TABLE_NAME = ?
        GROUP BY s.INDEX_NAME, s.TABLE_NAME, s.NON_UNIQUE, s.INDEX_TYPE
        ORDER BY s.INDEX_NAME`,
        [dbName, tableName]
      );
      return rows.map((row: any) => ({
        name: row.name,
        table: row.table_name,
        columns: row.columns_csv ? row.columns_csv.split(",") : [],
        isUnique: row.non_unique === 0,
        isPrimary: row.name === "PRIMARY",
        type: row.index_type,
      }));
    } finally {
      connection.release();
    }
  }

  async listTableSizes(engineId: string, config: EngineConfig, database?: string): Promise<TableSizeInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const resolved = config.url ? resolveMysqlConfig(engineId, config) : undefined;
      const dbName = database || config.database || resolved?.database;
      if (!dbName) throw new Error(`No database specified for engine "${engineId}". Pass a database parameter or configure one in config.yaml.`);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
          TABLE_NAME    as name,
          TABLE_ROWS    as \`rows\`,
          DATA_LENGTH   as data_length,
          INDEX_LENGTH  as index_length,
          DATA_FREE     as data_free,
          TABLE_COMMENT as comment
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`,
        [dbName]
      );
      return rows.map((row: any) => ({
        name: row.name,
        rows: row.rows,
        dataSizeBytes: row.data_length ?? 0,
        indexSizeBytes: row.index_length ?? 0,
        totalSizeBytes: (row.data_length ?? 0) + (row.index_length ?? 0),
        dataFreeBytes: row.data_free ?? 0,
        comment: row.comment || undefined,
      }));
    } finally {
      connection.release();
    }
  }

  async explainQuery(engineId: string, config: EngineConfig, query: string, _options?: ExplainOptions): Promise<ExplainResult> {
    // MySQL does not support EXPLAIN ANALYZE — the analyze flag is silently ignored.
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `EXPLAIN FORMAT=JSON ${query}`
      );
      // MySQL returns a single row with a JSON column named "EXPLAIN"
      const raw = rows[0]?.EXPLAIN ?? JSON.stringify(rows);
      let plan = raw;
      let estimatedCost: number | undefined;
      let estimatedRows: number | undefined;
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed?.query_block) {
          const qb = parsed.query_block;
          estimatedCost = qb.cost_info?.query_cost ?? undefined;
          estimatedRows = qb.table?.[0]?.rows_examined_per_scan ?? undefined;
        }
        plan = JSON.stringify(parsed, null, 2);
      } catch {
        // Not JSON-parseable — return raw text
      }
      return { plan, format: "json", estimatedCost, estimatedRows, analyzed: false };
    } finally {
      connection.release();
    }
  }

  async listSlowQueries(engineId: string, config: EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryInfo[]> {
    const limit = options?.limit ?? 10;
    const minDurationMs = options?.minDurationMs ?? 1000;
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      // MySQL: performance_schema.events_statements_summary_by_digest
      // Timer values are in picoseconds — divide by 1,000,000,000 to get milliseconds
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
          DIGEST_TEXT                  AS digest_text,
          SCHEMA_NAME                  AS schema_name,
          COUNT_STAR                   AS exec_count,
          SUM_TIMER_WAIT / 1000000000 AS total_time_ms,
          AVG_TIMER_WAIT / 1000000000 AS avg_time_ms,
          MAX_TIMER_WAIT / 1000000000 AS max_time_ms,
          SUM_ROWS_EXAMINED            AS rows_examined,
          SUM_ROWS_SENT                AS rows_returned,
          FIRST_SEEN                   AS first_seen,
          LAST_SEEN                    AS last_seen
        FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST_TEXT IS NOT NULL
          AND SUM_TIMER_WAIT / 1000000000 >= ?
        ORDER BY SUM_TIMER_WAIT DESC
        LIMIT ?`,
        [minDurationMs, limit]
      );
      return rows.map((row: any, i: number) => ({
        id: `mysql-${i}`,
        query: row.digest_text ?? "",
        database: row.schema_name ?? undefined,
        executionCount: Number(row.exec_count),
        totalExecutionTimeMs: Math.round(Number(row.total_time_ms)),
        avgExecutionTimeMs: Math.round(Number(row.avg_time_ms)),
        maxExecutionTimeMs: Math.round(Number(row.max_time_ms)),
        rowsExamined: Number(row.rows_examined) || undefined,
        rowsReturned: Number(row.rows_returned) || undefined,
        firstSeen: row.first_seen ? String(row.first_seen) : undefined,
        lastSeen: row.last_seen ? String(row.last_seen) : undefined,
      }));
    } catch (e: any) {
      // performance_schema may be disabled or not accessible
      if (e.message?.includes("performance_schema") || e.code === "ER_ACCESS_DENIED") {
        return [];
      }
      throw e;
    } finally {
      connection.release();
    }
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT ID as pid, USER as `user`, HOST as `host`, DB as `database`, COMMAND as `command`, TIME as `time`, STATE as `state`, INFO as `query` FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID != CONNECTION_ID()"
      );
      return rows.map((row: any) => ({
        pid: row.pid,
        user: row.user,
        host: row.host,
        database: row.database ?? null,
        command: row.command,
        time: row.time,
        state: row.state ?? null,
        query: row.query ?? null,
      }));
    } finally {
      connection.release();
    }
  }

  async query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult> {
    // Guardrail: only allow read-only queries for now
    const sqlUpper = sql.trim().toUpperCase();
    if (!(
      sqlUpper.startsWith("SELECT") ||
      sqlUpper.startsWith("WITH") ||
      sqlUpper.startsWith("SHOW") ||
      sqlUpper.startsWith("EXPLAIN") ||
      sqlUpper.startsWith("DESCRIBE") ||
      sqlUpper.startsWith("DESC")
    )) {
      throw new Error("Only read-only queries (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, DESC) are allowed for now.");
    }

    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows, fields] = await connection.query<RowDataPacket[]>(sql);
      const columns = fields.map((f) => f.name);
      const rowRecords = (rows as any[]).map((row) => {
        const record: Record<string, unknown> = {};
        for (const col of columns) {
          record[col] = row[col];
        }
        return record;
      });
      return { columns, rows: rowRecords };
    } finally {
      connection.release();
    }
  }

  async getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      // MySQL 8.0+ uses performance_schema.data_lock_waits (INNODB_LOCK_WAITS was removed)
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
          blocking_ps.PROCESSLIST_ID    AS blocking_pid,
          blocked_ps.PROCESSLIST_ID     AS blocked_pid,
          TIMESTAMPDIFF(MICROSECOND, blocked_thd.trx_wait_started, NOW()) DIV 1000 AS wait_duration_ms,
          blocked_thd.trx_state         AS wait_event,
          COALESCE(blocking_thd.trx_query, blocking_ps.PROCESSLIST_INFO, blocking_esc.SQL_TEXT) AS blocking_query,
          COALESCE(blocked_thd.trx_query, blocked_ps.PROCESSLIST_INFO) AS blocked_query,
          blocked_ps.PROCESSLIST_DB     AS database_name,
          NULL                          AS wait_type,
          blocked_ps.PROCESSLIST_STATE  AS status,
          blocked_ps.PROCESSLIST_HOST   AS host_name,
          NULL                          AS program_name,
          NULL                          AS login_time
        FROM performance_schema.data_lock_waits w
        JOIN information_schema.INNODB_TRX blocking_thd ON blocking_thd.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
        JOIN information_schema.INNODB_TRX blocked_thd  ON blocked_thd.trx_id  = w.REQUESTING_ENGINE_TRANSACTION_ID
        LEFT JOIN performance_schema.threads blocked_ps  ON blocked_ps.PROCESSLIST_ID  = blocked_thd.trx_mysql_thread_id
        LEFT JOIN performance_schema.threads blocking_ps ON blocking_ps.PROCESSLIST_ID = blocking_thd.trx_mysql_thread_id
        LEFT JOIN performance_schema.events_statements_current blocking_esc ON blocking_esc.THREAD_ID = blocking_ps.THREAD_ID`
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
        login_time: row.login_time ? String(row.login_time) : null,
      }));
    } finally {
      connection.release();
    }
  }

  async closeAllPools(): Promise<void> {
    for (const pool of this.pools.values()) {
      await pool.end();
    }
    this.pools.clear();
  }

  // ─── Sprint 9: Write operations + server diagnostics ───

  async killProcess(engineId: string, config: EngineConfig, pid: string, options?: { dryRun?: boolean }): Promise<KillResult> {
    const dryRun = options?.dryRun ?? false;
    const pidNum = parseInt(pid, 10);

    if (isNaN(pidNum) || pidNum <= 0) {
      return { success: false, found: false, pid, engineId, error: `Invalid PID: "${pid}" — expected a positive integer` };
    }

    // Check allowWriteOps
    if (!config.allowWriteOps) {
      return { success: false, found: false, pid, engineId, error: `Write operations disabled for engine "${engineId}". Set allowWriteOps: true in config.yaml.` };
    }

    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      // Look up the process
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT ID as pid, USER as `user`, HOST as `host`, DB as `database`, COMMAND as `command`, TIME as `time`, STATE as `state`, INFO as `query` FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID = ?",
        [pidNum]
      );

      const proc = rows[0] as any;
      const command = `KILL ${pidNum}`;
      const queryTrunc = proc?.query ? (proc.query as string).substring(0, 500) : undefined;
      const durationStr = proc ? `${proc.time}s` : undefined;

      // Process not found
      if (!proc) {
        if (dryRun) {
          return { success: false, found: false, wouldKill: true, pid, engineId, command, notes: "Process not found — may have terminated independently" };
        }
        // Try to kill anyway — check error to distinguish "already gone" from real errors
        try {
          await connection.query(`KILL ${pidNum}`);
        } catch (e: any) {
          const msg = e.message ?? String(e);
          if (msg.includes("Unknown thread") || msg.includes("not exist") || msg.includes("not found")) {
            return { success: true, found: false, pid, engineId, command, killedAt: new Date().toISOString(), notes: "Process not found — may have terminated independently" };
          }
          return { success: false, found: false, pid, engineId, command, error: msg };
        }
        return { success: true, found: false, pid, engineId, command, killedAt: new Date().toISOString(), notes: "Process not found — may have terminated independently" };
      }

      // Dry-run: return proposal
      if (dryRun) {
        return {
          success: false,
          found: true,
          wouldKill: true,
          pid,
          engineId,
          user: proc.user,
          database: proc.database ?? undefined,
          duration: durationStr,
          query: queryTrunc,
          command,
        };
      }

      // Execute the kill
      try {
        await connection.query(`KILL ${pidNum}`);
        const killedAt = new Date().toISOString();

        // Write audit log
        writeAuditEntry({
          timestamp: killedAt,
          action: "kill-process",
          engineId,
          pid,
          user: proc.user,
          database: proc.database ?? undefined,
          duration: durationStr,
          query: queryTrunc,
          command,
          success: true,
          killedAt,
        });

        return { success: true, found: true, pid, engineId, user: proc.user, database: proc.database ?? undefined, duration: durationStr, query: queryTrunc, command, killedAt };
      } catch (e: any) {
        const error = e.message ?? String(e);
        writeAuditEntry({
          timestamp: new Date().toISOString(),
          action: "kill-process",
          engineId,
          pid,
          user: proc.user,
          database: proc.database ?? undefined,
          duration: durationStr,
          query: queryTrunc,
          command,
          success: false,
          error,
        });
        return { success: false, found: true, pid, engineId, user: proc.user, database: proc.database ?? undefined, duration: durationStr, query: queryTrunc, command, error };
      }
    } finally {
      connection.release();
    }
  }

  async listReplicationStatus(engineId: string, config: EngineConfig): Promise<ReplicationStatus> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      // MySQL 8.0+ uses SHOW REPLICA STATUS; older uses SHOW SLAVE STATUS
      let rows: any[] = [];
      try {
        const [r] = await connection.query<RowDataPacket[]>("SHOW REPLICA STATUS");
        rows = r as any[];
      } catch {
        try {
          const [r] = await connection.query<RowDataPacket[]>("SHOW SLAVE STATUS");
          rows = r as any[];
        } catch {
          return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
        }
      }

      if (rows.length === 0) {
        // Could be a source/primary (no replica status) or replication not configured
        // Check if this is a source by looking for replicas
        try {
          const [replRows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) as cnt FROM performance_schema.replication_connection_status");
          if ((replRows[0] as any)?.cnt > 0) {
            return { role: "source", lagSeconds: null, status: "healthy", errorMessage: null };
          }
        } catch { /* ignore */ }
        return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
      }

      const r = rows[0];
      const replicaRunning = (r.Replica_IO_Running === "Yes" || r.Slave_IO_Running === "Yes") &&
                             (r.Replica_SQL_Running === "Yes" || r.Slave_SQL_Running === "Yes");
      const lag = r.Seconds_Behind_Source ?? r.Seconds_Behind_Master;
      const lastError = r.Last_IO_Error || r.Last_SQL_Error || null;

      if (!replicaRunning) {
        return { role: "replica", lagSeconds: lag != null ? Number(lag) : null, status: "down", errorMessage: lastError || "Replication threads not running" };
      }
      if (lastError && lastError.length > 0) {
        return { role: "replica", lagSeconds: lag != null ? Number(lag) : null, status: "degraded", errorMessage: lastError };
      }
      if (lag != null && Number(lag) > 60) {
        return { role: "replica", lagSeconds: Number(lag), status: "degraded", errorMessage: null };
      }

      return { role: "replica", lagSeconds: lag != null ? Number(lag) : null, status: "healthy", errorMessage: null };
    } finally {
      connection.release();
    }
  }

  async listServerVariables(engineId: string, config: EngineConfig): Promise<ServerVariable[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SHOW VARIABLES WHERE Variable_name IN (
          'version', 'version_comment', 'max_connections', 'innodb_buffer_pool_size',
          'innodb_log_file_size', 'long_query_time', 'slow_query_log', 'slow_query_log_file',
          'max_allowed_packet', 'wait_timeout', 'interactive_timeout', 'read_only',
          'super_read_only', 'character_set_server', 'collation_server',
          'autocommit', 'sql_mode', 'time_zone', 'system_time_zone',
          'innodb_flush_log_at_trx_commit', 'innodb_file_per_table', 'thread_cache_size',
          'table_open_cache', 'max_connect_errors', 'connect_timeout'
        ) ORDER BY Variable_name`
      );
      return rows.map((row: any) => ({ name: row.Variable_name, value: String(row.Value ?? "") }));
    } finally {
      connection.release();
    }
  }

  async listServerStatus(engineId: string, config: EngineConfig): Promise<ServerStatusMetric[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SHOW GLOBAL STATUS WHERE Variable_name IN (
          'Uptime', 'Threads_connected', 'Threads_running', 'Max_used_connections',
          'Aborted_clients', 'Aborted_connects', 'Connections', 'Queries', 'Questions',
          'Slow_queries', 'Com_select', 'Com_insert', 'Com_update', 'Com_delete',
          'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads',
          'Innodb_buffer_pool_pages_free', 'Innodb_buffer_pool_pages_total',
          'Bytes_received', 'Bytes_sent', 'Created_tmp_disk_tables',
          'Opened_tables', 'Open_tables', 'Table_locks_waited', 'Select_full_join'
        ) ORDER BY Variable_name`
      );
      return rows.map((row: any) => {
        const val = row.Value;
        const numVal = Number(val);
        return { name: row.Variable_name, value: isNaN(numVal) ? String(val ?? "") : numVal };
      });
    } finally {
      connection.release();
    }
  }
}

export const mysqlConnector = new MySQLConnector();
