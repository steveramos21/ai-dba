import pg, { type Pool } from "pg";
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

export class PostgreSQLConnector implements DatabaseConnector {
  private pools: Map<string, Pool> = new Map();

  getPool(engineId: string, config: EngineConfig): Pool {
    let pool = this.pools.get(engineId);
    if (!pool) {
      pool = new pg.Pool({
        connectionString: config.url,
        max: 5,
      });
      this.pools.set(engineId, pool);
    }
    return pool;
  }

  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT datname as name, pg_encoding_to_char(encoding) as charset FROM pg_database WHERE datistemplate = false"
      );
      return res.rows.map((row: any) => ({
        name: row.name,
        charset: row.charset,
      }));
    } finally {
      client.release();
    }
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      if (database) {
        // Filter by specific schema name
        const res = await client.query(
          "SELECT tablename as name, schemaname as schema FROM pg_tables WHERE schemaname = $1",
          [database]
        );
        return res.rows.map((row: any) => ({ name: row.name, schema: row.schema }));
      }
      const res = await client.query(
        "SELECT tablename as name, schemaname as schema FROM pg_tables WHERE schemaname = ANY(current_schemas(false))"
      );
      return res.rows.map((row: any) => ({ name: row.name, schema: row.schema }));
    } finally {
      client.release();
    }
  }

  async describeTable(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<ColumnInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      let schema = "public";
      let table = tableName;
      // Explicit database param overrides schema-qualified table name
      if (database) {
        schema = database;
      } else if (tableName.includes(".")) {
        const parts = tableName.split(".");
        schema = parts[0];
        table = parts[1];
      }
      const res = await client.query(
        `SELECT
          column_name as name,
          data_type as type,
          is_nullable as nullable,
          column_default as default_value
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
        [schema, table]
      );
      // Also get primary key info
      const pkRes = await client.query(
        `SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = $1 AND tc.table_name = $2`,
        [schema, table]
      );
      const pkColumns = new Set(pkRes.rows.map((r: any) => r.column_name));

      return res.rows.map((row: any) => ({
        name: row.name,
        type: row.type,
        nullable: row.nullable === "YES",
        isPrimary: pkColumns.has(row.name),
        isAutoIncrement: row.default_value?.includes("nextval") ?? false,
        defaultValue: row.default_value,
      }));
    } finally {
      client.release();
    }
  }

  async listIndexes(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<IndexInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      let schema = "public";
      let table = tableName;
      // Explicit database param overrides schema-qualified table name
      if (database) {
        schema = database;
      } else if (tableName.includes(".")) {
        const parts = tableName.split(".");
        schema = parts[0];
        table = parts[1];
      }
      const res = await client.query(
        "SELECT indexname as name, indexdef as definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2",
        [schema, table]
      );
      return res.rows.map((row: any) => {
        const def: string = row.definition ?? "";
        // Parse columns from indexdef like: CREATE INDEX name ON schema.table (col1, col2)
        const colsMatch = def.match(/\(([^)]+)\)/);
        const columns = colsMatch
          ? colsMatch[1].split(",").map((c: string) => c.trim().replace(/ .*/, ""))
          : [];
        const isUnique = def.toUpperCase().includes("UNIQUE");
        const isPrimary = row.name.endsWith("_pkey");
        return {
          name: row.name,
          table: table,
          columns,
          isUnique,
          isPrimary,
          type: isUnique ? "UNIQUE" : "BTREE",
        };
      });
    } finally {
      client.release();
    }
  }

  async listTableSizes(engineId: string, config: EngineConfig, database?: string): Promise<TableSizeInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      if (database) {
        // Filter by specific schema
        const res = await client.query(
          `SELECT
            c.relname       as name,
            n.nspname       as schema,
            c.reltuples::bigint as rows,
            pg_relation_size(c.oid)      as data_size,
            pg_indexes_size(c.oid)        as index_size,
            pg_total_relation_size(c.oid) as total_size
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname = $1
          ORDER BY pg_total_relation_size(c.oid) DESC`,
          [database]
        );
        return res.rows.map((row: any) => ({
          name: row.name,
          schema: row.schema,
          rows: Number(row.rows),
          dataSizeBytes: Number(row.data_size),
          indexSizeBytes: Number(row.index_size),
          totalSizeBytes: Number(row.total_size),
        }));
      }
      // All user schemas (exclude system)
      const res = await client.query(
        `SELECT
          c.relname       as name,
          n.nspname       as schema,
          c.reltuples::bigint as rows,
          pg_relation_size(c.oid)      as data_size,
          pg_indexes_size(c.oid)        as index_size,
          pg_total_relation_size(c.oid) as total_size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY pg_total_relation_size(c.oid) DESC`
      );
      return res.rows.map((row: any) => ({
        name: row.name,
        schema: row.schema,
        rows: Number(row.rows),
        dataSizeBytes: Number(row.data_size),
        indexSizeBytes: Number(row.index_size),
        totalSizeBytes: Number(row.total_size),
      }));
    } finally {
      client.release();
    }
  }

  async explainQuery(engineId: string, config: EngineConfig, query: string, options?: ExplainOptions): Promise<ExplainResult> {
    const analyze = options?.analyze ?? false;
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const options_ = analyze ? "FORMAT JSON, ANALYZE, BUFFERS" : "FORMAT JSON";
      const res = await client.query(`EXPLAIN (${options_}) ${query}`);
      // PostgreSQL returns one row with a JSON array column named "QUERY PLAN"
      const raw = res.rows[0]?.["QUERY PLAN"] ?? res.rows;
      let plan = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
      let estimatedCost: number | undefined;
      let estimatedRows: number | undefined;
      try {
        const parsed = Array.isArray(raw) ? raw[0] : (typeof raw === "string" ? JSON.parse(raw)[0] : raw);
        if (parsed?.Plan) {
          estimatedCost = parsed.Plan?.["Total Cost"];
          estimatedRows = parsed.Plan?.["Plan Rows"];
        }
        plan = JSON.stringify(Array.isArray(raw) ? raw : [parsed], null, 2);
      } catch {
        // Not JSON-parseable — return raw
      }
      return { plan, format: "json", estimatedCost, estimatedRows, analyzed: analyze };
    } finally {
      client.release();
    }
  }

  async listSlowQueries(engineId: string, config: EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryInfo[]> {
    const limit = options?.limit ?? 10;
    const minDurationMs = options?.minDurationMs ?? 1000;
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      // pg_stat_statements — requires the extension to be installed
      const res = await client.query(
        `SELECT
          queryid::text       AS query_id,
          query               AS query_text,
          calls               AS exec_count,
          total_exec_time     AS total_time_ms,
          mean_exec_time      AS avg_time_ms,
          max_exec_time       AS max_time_ms,
          rows               AS rows_returned,
          min_exec_time       AS min_time_ms
        FROM pg_stat_statements
        WHERE total_exec_time >= $1
        ORDER BY total_exec_time DESC
        LIMIT $2`,
        [minDurationMs, limit]
      );
      return res.rows.map((row: any) => ({
        id: `pg-${row.query_id}`,
        query: row.query_text ?? "",
        executionCount: Number(row.exec_count),
        totalExecutionTimeMs: Math.round(Number(row.total_time_ms)),
        avgExecutionTimeMs: Math.round(Number(row.avg_time_ms)),
        maxExecutionTimeMs: Math.round(Number(row.max_time_ms)),
        rowsReturned: Number(row.rows_returned) || undefined,
      }));
    } catch (e: any) {
      // Extension not installed or permission denied — return empty
      if (e.message?.includes("pg_stat_statements") ||
          e.message?.includes("does not exist") ||
          e.code === "42501" || e.code === "42P01") {
        return [];
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT pid, usename, client_addr, datname, state, query, EXTRACT(EPOCH FROM now() - state_change)::int as time FROM pg_stat_activity WHERE pid <> pg_backend_pid()"
      );
      return res.rows.map((row: any) => ({
        pid: row.pid,
        user: row.usename ?? "",
        host: row.client_addr ?? "",
        database: row.datname ?? null,
        command: "query",
        time: row.time ?? 0,
        state: row.state ?? null,
        query: row.query ?? null,
      }));
    } finally {
      client.release();
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
    const client = await pool.connect();
    try {
      const res = await client.query(sql);
      const columns = res.fields.map((f) => f.name);
      const rowRecords = res.rows.map((row: any) => {
        const record: Record<string, unknown> = {};
        for (const col of columns) {
          record[col] = row[col];
        }
        return record;
      });
      return { columns, rows: rowRecords };
    } finally {
      client.release();
    }
  }

  async getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT
          blocking.pid        AS blocking_pid,
          blocked.pid         AS blocked_pid,
          EXTRACT(EPOCH FROM (now() - blocked.query_start)) * 1000  AS wait_duration_ms,
          blocked.wait_event  AS wait_event,
          blocking.query      AS blocking_query,
          blocked.query       AS blocked_query,
          blocked.datname     AS database_name,
          blocked.wait_event_type AS wait_type,
          blocked.state       AS status,
          blocked.client_addr AS host_name,
          blocked.application_name AS program_name,
          blocked.backend_start    AS login_time
        FROM pg_stat_activity blocked
        JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS block_pid ON true
        JOIN pg_stat_activity blocking ON blocking.pid = block_pid
        WHERE blocked.wait_event IS NOT NULL`
      );
      return res.rows.map((row: any) => ({
        engine_id: engineId,
        blocking_pid: row.blocking_pid,
        blocked_pid: row.blocked_pid,
        wait_duration_ms: row.wait_duration_ms != null ? Math.round(Number(row.wait_duration_ms)) : null,
        wait_event: row.wait_event ?? null,
        blocking_query: row.blocking_query ?? null,
        blocked_query: row.blocked_query ?? null,
        database_name: row.database_name ?? null,
        wait_type: row.wait_type ?? null,
        status: row.status ?? null,
        host_name: row.host_name ? String(row.host_name) : null,
        program_name: row.program_name ?? null,
        login_time: row.login_time ? String(row.login_time) : null,
      }));
    } finally {
      client.release();
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

    if (!config.allowWriteOps) {
      return { success: false, found: false, pid, engineId, error: `Write operations disabled for engine "${engineId}". Set allowWriteOps: true in config.yaml.` };
    }

    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      // Look up the process
      const res = await client.query(
        "SELECT pid, usename, client_addr, datname, state, query, EXTRACT(EPOCH FROM now() - state_change)::int as time FROM pg_stat_activity WHERE pid = $1",
        [pidNum]
      );

      const proc = res.rows[0] as any;
      const command = `SELECT pg_terminate_backend(${pidNum})`;
      const queryTrunc = proc?.query ? (proc.query as string).substring(0, 500) : undefined;
      const durationStr = proc ? `${proc.time ?? 0}s` : undefined;

      // Process not found
      if (!proc) {
        if (dryRun) {
          return { success: false, found: false, wouldKill: true, pid, engineId, command, notes: "Process not found — may have terminated independently" };
        }
        // Try to terminate anyway — check error to distinguish "already gone" from real errors
        try {
          await client.query(`SELECT pg_terminate_backend(${pidNum})`);
        } catch (e: any) {
          const msg = e.message ?? String(e);
          if (msg.includes("does not exist") || msg.includes("not found") || msg.includes("PID does not exist")) {
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
          user: proc.usename, database: proc.datname ?? undefined,
          duration: durationStr, query: queryTrunc, command,
        };
      }

      // Execute the kill
      try {
        const killRes = await client.query(`SELECT pg_terminate_backend(${pidNum}) as terminated`);
        const terminated = (killRes.rows[0] as any)?.terminated === true;
        const killedAt = new Date().toISOString();

        writeAuditEntry({
          timestamp: killedAt, action: "kill-process", engineId, pid,
          user: proc.usename, database: proc.datname ?? undefined,
          duration: durationStr, query: queryTrunc, command,
          success: true, killedAt,
        });

        return {
          success: true, found: true, pid, engineId,
          user: proc.usename, database: proc.datname ?? undefined,
          duration: durationStr, query: queryTrunc, command, killedAt,
          notes: terminated ? undefined : "pg_terminate_backend returned false — session may have already ended",
        };
      } catch (e: any) {
        const error = e.message ?? String(e);
        writeAuditEntry({
          timestamp: new Date().toISOString(), action: "kill-process", engineId, pid,
          user: proc.usename, database: proc.datname ?? undefined,
          duration: durationStr, query: queryTrunc, command,
          success: false, error,
        });
        return { success: false, found: true, pid, engineId, user: proc.usename, database: proc.datname ?? undefined, duration: durationStr, query: queryTrunc, command, error };
      }
    } finally {
      client.release();
    }
  }

  async listReplicationStatus(engineId: string, config: EngineConfig): Promise<ReplicationStatus> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      // Check if this is a primary with replicas
      const senderRes = await client.query(
        "SELECT pid, state, sync_state, sent_lsn, replay_lsn, EXTRACT(EPOCH FROM replay_lag)::int as lag_seconds FROM pg_stat_replication"
      );

      if (senderRes.rows.length > 0) {
        // This is a primary/source
        const maxLag = Math.max(...senderRes.rows.map((r: any) => r.lag_seconds ?? 0));
        return {
          role: "primary",
          lagSeconds: maxLag > 0 ? maxLag : 0,
          status: maxLag > 60 ? "degraded" : "healthy",
          errorMessage: null,
        };
      }

      // Check if this is a replica
      const receiverRes = await client.query(
        "SELECT status, sender_host, slot_name, latest_end_lsn, latest_end_time, EXTRACT(EPOCH FROM (now() - latest_end_time))::int as lag_seconds FROM pg_stat_wal_receiver"
      );

      if (receiverRes.rows.length > 0) {
        const r = receiverRes.rows[0] as any;
        const lag = r.lag_seconds ?? 0;
        if (r.status !== "streaming") {
          return { role: "replica", lagSeconds: lag, status: "down", errorMessage: `Replication status: ${r.status}` };
        }
        if (lag > 60) {
          return { role: "replica", lagSeconds: lag, status: "degraded", errorMessage: null };
        }
        return { role: "replica", lagSeconds: lag, status: "healthy", errorMessage: null };
      }

      return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
    } catch (e: any) {
      // pg_stat_replication may not be accessible
      return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: e.message ?? String(e) };
    } finally {
      client.release();
    }
  }

  async listServerVariables(engineId: string, config: EngineConfig): Promise<ServerVariable[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT name, setting as value, short_desc as description
        FROM pg_settings
        WHERE name IN (
          'server_version', 'max_connections', 'shared_buffers', 'work_mem',
          'maintenance_work_mem', 'effective_cache_size', 'wal_buffers',
          'log_min_duration_statement', 'checkpoint_timeout', 'max_wal_size',
          'random_page_cost', 'default_statistics_target', 'autovacuum',
          'track_activities', 'track_counts', 'listen_addresses',
          'timezone', 'data_checksums', 'hot_standby', 'wal_level',
          'max_replication_slots', 'max_wal_senders', 'synchronous_commit',
          'statement_timeout', 'idle_in_transaction_session_timeout',
          'lock_timeout', 'log_connections', 'log_disconnections'
        )
        ORDER BY name`
      );
      return res.rows.map((row: any) => ({
        name: row.name,
        value: String(row.value ?? ""),
        description: row.description ?? undefined,
      }));
    } finally {
      client.release();
    }
  }

  async listServerStatus(engineId: string, config: EngineConfig): Promise<ServerStatusMetric[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT 'xact_commit' as name, xact_commit::text as value FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'xact_rollback', xact_rollback::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'blks_read', blks_read::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'blks_hit', blks_hit::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'tup_returned', tup_returned::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'tup_fetched', tup_fetched::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'tup_inserted', tup_inserted::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'tup_updated', tup_updated::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'tup_deleted', tup_deleted::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'conflicts', conflicts::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'temp_files', temp_files::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'deadlocks', deadlocks::text FROM pg_stat_database WHERE datname = current_database()
        UNION ALL SELECT 'numbackends', count(*)::text FROM pg_stat_activity WHERE datname = current_database()
        UNION ALL SELECT 'active_queries', count(*)::text FROM pg_stat_activity WHERE state = 'active' AND datname = current_database()
        UNION ALL SELECT 'idle_in_transaction', count(*)::text FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()`
      );
      return res.rows.map((row: any) => {
        const val = row.value;
        const numVal = Number(val);
        return { name: row.name, value: isNaN(numVal) ? String(val ?? "") : numVal };
      });
    } finally {
      client.release();
    }
  }
}

export const postgresConnector = new PostgreSQLConnector();