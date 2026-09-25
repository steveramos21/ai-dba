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
  SlowQueryResult,
  KillResult,
  ReplicationStatus,
  ServerVariable,
  ServerStatusMetric,
} from "../connector.js";
import { writeAuditEntry } from "../audit.js";
import {
  resolveRowLimit,
  resolveConnectTimeoutMs,
  resolveQueryTimeoutMs,
  timeoutConfigFingerprint,
} from "../config.js";
import { applyRowCap, rewriteWithFetchFirst } from "../truncate.js";
import { withTimeout, QueryTimeoutError } from "../timeouts.js";

// Driver loaded on FIRST use, never at module load — keeps CLI/MCP
// startup free of driver cost. Guarded by npm run test:coldstart.
let driverPromise: Promise<typeof import("oracledb")> | undefined;
function loadDriver(): Promise<typeof import("oracledb")> {
  if (!driverPromise) {
    driverPromise = import("oracledb").catch((err) => {
      // Clear the memo on failure so a later call can retry — a transient load
      // failure must not poison the connector for the process lifetime.
      driverPromise = undefined;
      throw err;
    });
  }
  return driverPromise;
}

/**
 * Parse an oracle:// connection URL into oracledb connect options.
 * Format: oracle://user:password@host:port/service
 */
export function parseOracleUrl(url: string): {
  user: string;
  password: string;
  connectString: string;
} {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port || "1521";
    const service = decodeURIComponent(parsed.pathname.slice(1)) || "XE";
    return {
      user: decodeURIComponent(parsed.username || "system"),
      password: decodeURIComponent(parsed.password || ""),
      connectString: `${host}:${port}/${service}`,
    };
  } catch {
    throw new Error(
      `Invalid Oracle URL: ${url}\n` +
      `Expected: oracle://user:password@host:port/service`
    );
  }
}

export class OracleConnector implements DatabaseConnector {
  private pools: Map<string, any> = new Map();
  private creatingPools: Map<string, Promise<any>> = new Map();
  // Timeout fingerprint baked into each cached pool at creation (Task 1.3):
  // a later config override on the same engineId must rebuild the pool.
  private poolFingerprints: Map<string, string> = new Map();

  private async getPool(engineId: string, config: EngineConfig): Promise<any> {
    const fingerprint = timeoutConfigFingerprint(config);
    const cached = this.pools.get(engineId);
    if (cached) {
      const recorded = this.poolFingerprints.get(engineId);
      if (recorded === undefined) {
        // Pool seeded outside getPool (tests / hand-wired callers): adopt it.
        this.poolFingerprints.set(engineId, fingerprint);
        return cached;
      }
      if (recorded === fingerprint) return cached;
      // Stale: the config changed — tear the old pool down, rebuild below.
      this.pools.delete(engineId);
      this.poolFingerprints.delete(engineId);
      void Promise.resolve(cached.close()).catch(() => { /* best-effort teardown of the stale pool */ });
    }
    const inFlight = this.creatingPools.get(engineId);
    if (inFlight) return inFlight;
    const creating = (async () => {
      const cfg = config.url
        ? parseOracleUrl(config.url)
        : {
            user: config.user || "system",
            password: config.password || "",
            connectString: `${config.host || "localhost"}:${config.port || 1521}/${config.database || "XE"}`,
          };

      const { default: oracledb } = await loadDriver();
      const pool = await oracledb.createPool({
        user: cfg.user,
        password: cfg.password,
        connectString: cfg.connectString,
        poolMin: 1,
        poolMax: 5,
        poolIncrement: 1,
        // Sprint 10 Part 2a — connectTimeout for pooled connections is in
        // SECONDS in node-oracledb (verified: lib/thin/sqlnet/sessionAtts.js
        // multiplies params.connectTimeout by 1000). Round UP so a configured
        // budget is never silently shortened.
        connectTimeout: Math.ceil(resolveConnectTimeoutMs(config) / 1000),
      });
      this.pools.set(engineId, pool);
      this.poolFingerprints.set(engineId, fingerprint);
      return pool;
    })().finally(() => this.creatingPools.delete(engineId));
    this.creatingPools.set(engineId, creating);
    return creating;
  }
  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      // all_users is accessible without SELECT ANY DICTIONARY
      const result = await conn.execute(
        `SELECT username AS name FROM all_users ORDER BY username`
      );
      const rows = result.rows || [];
      return rows.map((row: any) => ({ name: row[0] }));
    } finally {
      await conn.close();
    }
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      let result;
      if (database) {
        // Filter by schema — all_objects is accessible without privileges
        const owner = database.toUpperCase();
        result = await conn.execute(
          `SELECT object_name AS name, owner AS schema FROM all_objects WHERE object_type = 'TABLE' AND owner = :owner ORDER BY object_name`,
          [owner]
        );
      } else {
        // Default: current user's tables — user_objects has no OWNER column
        result = await conn.execute(
          `SELECT object_name AS name, USER AS schema FROM user_objects WHERE object_type = 'TABLE' ORDER BY object_name`
        );
      }
      const rows = result.rows || [];
      return rows.map((row: any) => ({
        name: row[0],
        schema: row[1],
      }));
    } finally {
      await conn.close();
    }
  }

  async describeTable(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<ColumnInfo[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const table = tableName.toUpperCase();

      // user_tab_columns — no SELECT ANY DICTIONARY needed
      const result = await conn.execute(
        `SELECT
          column_name,
          data_type,
          nullable,
          data_default,
          identity_column
        FROM user_tab_columns
        WHERE table_name = :tbl
        ORDER BY column_id`,
        [table]
      );

      // Get PK info via user_constraints (no dictionary privilege needed)
      const pkResult = await conn.execute(
        `SELECT cc.column_name
        FROM user_constraints c
        JOIN user_cons_columns cc ON c.constraint_name = cc.constraint_name
        WHERE c.constraint_type = 'P'
          AND c.table_name = :tbl`,
        [table]
      );
      const pkColumns = new Set((pkResult.rows || []).map((r: any) => r[0]));

      const rows = result.rows || [];
      return rows.map((row: any) => ({
        name: row[0],
        type: row[1],
        nullable: row[2] === "Y",
        isPrimary: pkColumns.has(row[0]),
        isAutoIncrement: Boolean(row[4]),
        defaultValue: row[3] != null ? String(row[3]) : null,
      }));
    } finally {
      await conn.close();
    }
  }

  async listIndexes(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<IndexInfo[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const table = tableName.toUpperCase();

      const result = await conn.execute(
        `SELECT
          i.index_name,
          i.uniqueness,
          ic.column_name,
          ic.column_position
        FROM user_indexes i
        JOIN user_ind_columns ic ON i.index_name = ic.index_name
        WHERE i.table_name = :tbl
        ORDER BY i.index_name, ic.column_position`,
        [table]
      );

      const rows = result.rows || [];
      const indexMap = new Map<string, { name: string; isUnique: boolean; columns: string[]; isPrimary: boolean }>();
      for (const row of rows) {
        const name = row[0] as string;
        const uniqueness = row[1] as string;
        const column = row[2] as string;
        if (!indexMap.has(name)) {
          indexMap.set(name, {
            name,
            isUnique: uniqueness === "UNIQUE",
            columns: [],
            isPrimary: name.startsWith("PK_") || name.startsWith("SYS_"),
          });
        }
        indexMap.get(name)!.columns.push(column);
      }

      return Array.from(indexMap.values()).map((i) => ({
        name: i.name,
        table: tableName,
        columns: i.columns,
        isUnique: i.isUnique,
        isPrimary: i.isPrimary,
        type: i.isUnique ? "UNIQUE" : "BTREE",
      }));
    } finally {
      await conn.close();
    }
  }

  async listTableSizes(engineId: string, config: EngineConfig, database?: string): Promise<TableSizeInfo[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      let result;
      if (database) {
        // Filter by schema — use all_segments for cross-schema
        const owner = database.toUpperCase();
        result = await conn.execute(
          `SELECT
            segment_name AS name,
            SUM(CASE WHEN segment_type = 'TABLE' THEN bytes ELSE 0 END) AS data_bytes,
            SUM(CASE WHEN segment_type = 'INDEX' THEN bytes ELSE 0 END) AS index_bytes,
            SUM(bytes) AS total_bytes
          FROM all_segments
          WHERE segment_type IN ('TABLE','INDEX') AND owner = :1
          GROUP BY segment_name
          ORDER BY SUM(bytes) DESC`,
          [owner]
        );
      } else {
        // Current user's tables — user_segments (no DBA privilege needed)
        result = await conn.execute(
          `SELECT
            segment_name AS name,
            SUM(CASE WHEN segment_type = 'TABLE' THEN bytes ELSE 0 END) AS data_bytes,
            SUM(CASE WHEN segment_type = 'INDEX' THEN bytes ELSE 0 END) AS index_bytes,
            SUM(bytes) AS total_bytes
          FROM user_segments
          WHERE segment_type IN ('TABLE','INDEX')
          GROUP BY segment_name
          ORDER BY SUM(bytes) DESC`
        );
      }
      const rows = result.rows || [];
      return rows.map((row: any) => ({
        name: row[0],
        dataSizeBytes: Number(row[1]),
        indexSizeBytes: Number(row[2]),
        totalSizeBytes: Number(row[3]),
      }));
    } catch (e: any) {
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return [];
      }
      throw e;
    } finally {
      await conn.close();
    }
  }

  async explainQuery(engineId: string, config: EngineConfig, query: string, _options?: ExplainOptions): Promise<ExplainResult> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    const stmtId = `ai_dba_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    try {
      // Step 1: Run EXPLAIN PLAN
      await conn.execute(
        `EXPLAIN PLAN SET STATEMENT_ID = '${stmtId}' FOR ${query}`,
        []
      );
      // Step 2: Read the plan via DBMS_XPLAN
      let plan = "";
      let degraded: string | undefined;
      try {
        const result = await conn.execute(
          `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '${stmtId}'))`,
          []
        );
        const rows = result.rows || [];
        plan = rows.map((r: any) => r[0]).join("\n");
      } catch (e: any) {
        // DBMS_XPLAN might not be available (privilege/version) — fall back to
        // plan_table, but surface the source swap instead of silently
        // presenting a fallback plan as if it were the preferred one (Task 1.4).
        degraded = `DBMS_XPLAN.DISPLAY unavailable; plan read from plan_table instead: ${e?.message ?? String(e)}`;
        const result = await conn.execute(
          `SELECT
            LPAD(' ', LEVEL-1) || operation || ' ' || options || ' ' || object_name AS plan_line
          FROM plan_table
          CONNECT BY PRIOR id = parent_id AND statement_id = '${stmtId}'
          START WITH id = 0 AND statement_id = '${stmtId}'
          ORDER BY id`,
          []
        );
        const rows = result.rows || [];
        plan = rows.map((r: any) => r[0]).join("\n");
      }
      return { plan, format: "text", analyzed: false, ...(degraded ? { degraded } : {}) };
    } finally {
      // Step 3: Clean up — always delete the plan rows
      try {
        await conn.execute(
          `DELETE FROM plan_table WHERE statement_id = '${stmtId}'`,
          []
        );
      } catch {
        // If plan_table doesn't exist or no rows, ignore
      }
      await conn.close();
    }
  }

  async listSlowQueries(engineId: string, config: EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryResult> {
    const limit = options?.limit ?? 10;
    const minDurationMs = options?.minDurationMs ?? 1000;
    const minDurationUs = minDurationMs * 1000;
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      // Oracle: V$SQLAREA — elapsed_time is in microseconds
      const result = await conn.execute(
        `SELECT
          sql_id,
          sql_text,
          executions       AS exec_count,
          elapsed_time     AS total_time_us,
          elapsed_time / NULLIF(executions, 0) AS avg_time_us,
          NULL AS max_time_us, -- v$sqlarea has no per-query max_elapsed_time (SQL Server DMV name); null keeps positional indices stable
          disk_reads,
          buffer_gets,
          rows_processed   AS rows_returned
        FROM v$sqlarea
        WHERE elapsed_time >= :1
          AND sql_text IS NOT NULL
        ORDER BY elapsed_time DESC
        FETCH FIRST :2 ROWS ONLY`,
        [minDurationUs, limit]
      );
      const rows = result.rows || [];
      return { queries: rows.map((row: any) => ({
        id: `oracle-${row[0]}`,
        query: (row[1] ?? "").substring(0, 2000),
        executionCount: Number(row[2]) || undefined,
        totalExecutionTimeMs: Math.round(Number(row[3]) / 1000),
        avgExecutionTimeMs: row[4] ? Math.round(Number(row[4]) / 1000) : undefined,
        maxExecutionTimeMs: row[5] != null ? Math.round(Number(row[5]) / 1000) : undefined,
        rowsReturned: Number(row[8]) || undefined,
      })) };
    } catch (e: any) {
      // V$SQLAREA requires SELECT ANY DICTIONARY — a denial is "couldn't read
      // the source" (empty + degraded), never a silent empty. Whitelist-only:
      // ORA-00942 (view does not exist) and ORA-01031 (insufficient
      // privileges). ORA-00904 (invalid identifier - wrong column) is NOT
      // whitelisted: it must rethrow and surface as an error.
      const msg = String(e?.message ?? "");
      if (msg.includes("ORA-00942") || msg.includes("ORA-01031")) {
        return {
          queries: [],
          degraded: {
            reason: `v$sqlarea unavailable (requires SELECT ANY DICTIONARY): ${msg}`,
          },
        };
      }
      throw e;
    } finally {
      await conn.close();
    }
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      // v$session requires SELECT ANY DICTIONARY — return empty if no permission
      const result = await conn.execute(
        `SELECT
          s.sid AS pid,
          s.serial# AS serial_num,
          s.username AS user_name,
          s.machine AS host,
          s.status AS status,
          s.last_call_et AS time,
          q.sql_text AS query
        FROM v$session s
        LEFT JOIN v$sql q ON s.sql_id = q.sql_id
        WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')`
      );
      const rows = result.rows || [];
      return rows.map((row: any) => ({
        pid: row[0],
        serial: row[1] ?? undefined,
        user: row[2] ?? "",
        host: row[3] ?? "",
        database: null,
        command: "query",
        time: row[5] ?? 0,
        state: row[4] ?? null,
        query: row[6] ?? null,
      }));
    } catch (e: any) {
      // ORA-00942: table or view does not exist (needs SELECT ANY DICTIONARY)
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return [];
      }
      throw e;
    } finally {
      await conn.close();
    }
  }

  async query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult> {
    const sqlUpper = sql.trim().toUpperCase();
    if (!(
      sqlUpper.startsWith("SELECT") ||
      sqlUpper.startsWith("WITH") ||
      sqlUpper.startsWith("DESCRIBE") ||
      sqlUpper.startsWith("EXPLAIN")
    )) {
      throw new Error("Only read-only queries (SELECT, WITH, EXPLAIN, DESCRIBE) are allowed for now.");
    }

    const cap = resolveRowLimit(config);
    const queryTimeoutMs = resolveQueryTimeoutMs(config);
    // Sprint 10 Part 2a — row cap. Server-side FETCH FIRST n+1 only when
    // provably safe (see src/truncate.ts); on any doubt the statement runs as
    // written and the client-side slice below enforces the cap with the same
    // honest flag. maxRows must be set explicitly rather than relying on the
    // driver default, which varies by release (0 = unlimited in oracledb 7,
    // capped at 100 in older drivers) — cap + 1 bounds the driver-side fetch
    // to exactly what the cap logic needs.
    const effectiveSql = rewriteWithFetchFirst(sql, cap + 1) ?? sql;

    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    // callTimeout is a per-connection round-trip bound in ms; set it on every
    // query so a pooled connection always carries this engine's current bound
    // (the pool fingerprint above guarantees a config change rebuilds the pool).
    conn.callTimeout = queryTimeoutMs;
    let timedOut = false;
    try {
      // Annotated because conn is `any` (Oracle pools are typed any) — without
      // it, withTimeout<T> would infer T = unknown and lose the Result shape.
      const execPromise: Promise<import("oracledb").Result> = conn.execute(effectiveSql, [], { resultSet: false, maxRows: cap + 1 });
      // If the race below expires first, this promise may still reject later;
      // swallow that late rejection so it can't crash the process.
      execPromise.catch(() => {});
      const result = await withTimeout(execPromise, queryTimeoutMs, `oracle query (${engineId})`)
        .catch((err) => {
          // ORA-01013 is the server-side twin of our race expiry (callTimeout
          // fired). Either way the session is mid-call and must not be reused.
          if (err instanceof QueryTimeoutError || /ORA-01013/.test(String((err as any)?.message))) {
            timedOut = true;
          }
          throw err;
        });
      const columns = (result.metaData || []).map((m: { name: string }) => m.name);
      const rows: Record<string, unknown>[] = (result.rows || []).map((row: any[]) => {
        const record: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
          record[columns[i]] = row[i];
        }
        return record;
      });
      const capped = applyRowCap(rows, cap);
      return {
        columns,
        rows: capped.rows,
        // Only surfaced when rows were actually dropped ("no flag" otherwise).
        truncated: capped.truncated || undefined,
        rowCap: capped.truncated ? capped.rowCap : undefined,
      };
    } finally {
      // On timeout the session is mid-call — drop it (never return it to the
      // pool) so it cannot hold a pool slot. The drop itself may fail against
      // a dead session; the connection is discarded either way.
      if (timedOut) {
        // Detached on purpose (v2 fix, 2026-09-26): oracledb's close() waits
        // for the in-flight call to settle, so awaiting it here held the
        // CALLER to server completion — the exact contract this timeout
        // exists to prevent (live probe: SLEEP(30) surfaced at 30.3s with an
        // awaited drop, vs the 2000ms override). Initiate the drop, return
        // promptly; teardown completes in the background (the exec promise's
        // late rejection is already guarded above).
        void Promise.resolve(conn.close({ drop: true })).catch(() => { /* session already unusable */ });
      } else {
        await conn.close();
      }
    }
  }

  async getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const result = await conn.execute(
        `SELECT
          blocker.sid    AS blocking_pid,
          blocked.sid    AS blocked_pid,
          blocked.seconds_in_wait * 1000 AS wait_duration_ms,
          blocked.event   AS wait_event,
          blocker_sql.sql_text AS blocking_query,
          blocked_sql.sql_text AS blocked_query,
          blocked.username AS database_name,
          blocked.wait_class AS wait_type,
          blocked.status   AS status,
          blocked.machine   AS host_name,
          blocked.program   AS program_name,
          NULL              AS login_time
        FROM v$session blocked
        JOIN v$session blocker ON blocked.blocking_session = blocker.sid
        LEFT JOIN v$sql blocker_sql ON blocker.sql_id = blocker_sql.sql_id
        LEFT JOIN v$sql blocked_sql ON blocked.sql_id = blocked_sql.sql_id
        WHERE blocked.blocking_session IS NOT NULL`
      );
      const rows = result.rows || [];
      return rows.map((row: any) => ({
        engine_id: engineId,
        blocking_pid: row[0],
        blocked_pid: row[1],
        wait_duration_ms: row[2] ?? null,
        wait_event: row[3] ?? null,
        blocking_query: row[4] ?? null,
        blocked_query: row[5] ?? null,
        database_name: row[6] ?? null,
        wait_type: row[7] ?? null,
        status: row[8] ?? null,
        host_name: row[9] ?? null,
        program_name: row[10] ?? null,
        login_time: row[11] ?? null,
      }));
    } catch (e: any) {
      // ORA-00942 or ORA-01031 — needs SELECT ANY DICTIONARY
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return [];
      }
      throw e;
    } finally {
      await conn.close();
    }
  }

  async closeAllPools(): Promise<void> {
    for (const pool of this.pools.values()) {
      await pool.close();
    }
    this.pools.clear();
    this.poolFingerprints.clear();
  }

  // ─── Sprint 9: Write operations + server diagnostics ───

  async killProcess(engineId: string, config: EngineConfig, pid: string, options?: { dryRun?: boolean }): Promise<KillResult> {
    const dryRun = options?.dryRun ?? false;

    if (!config.allowWriteOps) {
      return { success: false, found: false, pid, engineId, error: `Write operations disabled for engine "${engineId}". Set allowWriteOps: true in config.yaml.` };
    }

    // Parse "SID,SERIAL#" format
    const parts = pid.split(",");
    if (parts.length !== 2) {
      return { success: false, found: false, pid, engineId, error: `Invalid Oracle PID: "${pid}" — expected "SID,SERIAL#" format (e.g., "42,123")` };
    }
    const sid = parseInt(parts[0], 10);
    const serial = parseInt(parts[1], 10);
    if (isNaN(sid) || isNaN(serial) || sid <= 0 || serial < 0) {
      return { success: false, found: false, pid, engineId, error: `Invalid Oracle PID: "${pid}" — SID and SERIAL# must be integers` };
    }

    const command = `ALTER SYSTEM KILL SESSION '${sid},${serial}'`;
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      // Look up the process by SID
      const result = await conn.execute(
        `SELECT s.sid, s.serial#, s.username, s.machine, s.status, s.last_call_et, q.sql_text
         FROM v$session s
         LEFT JOIN v$sql q ON s.sql_id = q.sql_id
         WHERE s.sid = :1 AND s.serial# = :2`,
        [sid, serial]
      );

      const proc = (result.rows || [])[0] as any;
      const queryTrunc = proc?.[6] ? String(proc[6]).substring(0, 500) : undefined;
      const durationStr = proc ? `${proc[5] ?? 0}s` : undefined;

      // Process not found
      if (!proc) {
        if (dryRun) {
          return { success: false, found: false, wouldKill: true, pid, engineId, command, notes: "Process not found — may have terminated independently" };
        }
        // Try to kill anyway — check error to distinguish "already gone" from real errors
        try {
          await conn.execute(`ALTER SYSTEM KILL SESSION '${sid},${serial}'`);
        } catch (e: any) {
          const msg = e.message ?? String(e);
          if (msg.includes("ORA-00030") || msg.includes("does not exist") || msg.includes("not found") || msg.includes("session mark")) {
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
          user: proc[2] ?? undefined, database: undefined,
          duration: durationStr, query: queryTrunc, command,
        };
      }

      // Execute the kill
      try {
        await conn.execute(`ALTER SYSTEM KILL SESSION '${sid},${serial}'`);
        const killedAt = new Date().toISOString();

        writeAuditEntry({
          timestamp: killedAt, action: "kill-process", engineId, pid,
          user: proc[2] ?? undefined, database: undefined,
          duration: durationStr, query: queryTrunc, command,
          success: true, killedAt,
          notes: "Session marked for kill. Will terminate on next transaction boundary.",
        });

        return {
          success: true, found: true, pid, engineId,
          user: proc[2] ?? undefined, duration: durationStr, query: queryTrunc, command, killedAt,
          notes: "Session marked for kill. Will terminate on next transaction boundary.",
        };
      } catch (e: any) {
        const error = e.message ?? String(e);
        writeAuditEntry({
          timestamp: new Date().toISOString(), action: "kill-process", engineId, pid,
          user: proc[2] ?? undefined, database: undefined,
          duration: durationStr, query: queryTrunc, command,
          success: false, error,
        });
        return { success: false, found: true, pid, engineId, user: proc[2] ?? undefined, duration: durationStr, query: queryTrunc, command, error };
      }
    } catch (e: any) {
      // v$session requires SELECT ANY DICTIONARY
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return { success: false, found: false, pid, engineId, error: "Cannot query v$session — requires SELECT ANY DICTIONARY privilege" };
      }
      throw e;
    } finally {
      await conn.close();
    }
  }

  async listReplicationStatus(engineId: string, config: EngineConfig): Promise<ReplicationStatus> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      // Check if Data Guard is configured at all
      let dgConfigured = false;
      try {
        const dgConfig = await conn.execute("SELECT COUNT(*) FROM v$dataguard_config");
        dgConfigured = ((dgConfig.rows?.[0] as any)?.[0] ?? 0) > 0;
      } catch { /* view not accessible = no Data Guard */ }

      if (!dgConfigured) {
        return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
      }

      // Data Guard IS configured — check role and status
      const result = await conn.execute(
        `SELECT role FROM v$database`
      );
      const dbRole = (result.rows?.[0] as any)?.[0] as string;

      // Try to get Data Guard lag
      try {
        const dgResult = await conn.execute(
          `SELECT
             CASE WHEN COUNT(*) = 0 THEN 'NONE'
                  ELSE MAX(facility)
             END AS facility,
             MAX(message) AS last_message
           FROM v$dataguard_status
           WHERE severity IN ('ERROR','FATAL')`
        );
        const hasErrors = ((dgResult.rows || []).length > 0) && ((dgResult.rows[0] as any)?.[0] !== "NONE");

        // Check for standby lag
        const lagResult = await conn.execute(
          `SELECT
             MAX(CASE WHEN name = 'Log archive buffers (total)' THEN value ELSE 0 END) AS total_buffers
           FROM v$sysstat
           WHERE name LIKE 'Log archive%'`
        );

        // Determine role
        if (dbRole === "PRIMARY") {
          return { role: "primary", lagSeconds: null, status: hasErrors ? "degraded" : "healthy", errorMessage: hasErrors ? "Data Guard errors detected" : null };
        }
        if (dbRole === "PHYSICAL STANDBY" || dbRole === "LOGICAL STANDBY" || dbRole === "SNAPSHOT STANDBY") {
          return { role: "standby", lagSeconds: null, status: hasErrors ? "degraded" : "healthy", errorMessage: hasErrors ? "Data Guard errors detected" : null };
        }

        return { role: dbRole?.toLowerCase() ?? "none", lagSeconds: null, status: "healthy", errorMessage: null };
      } catch {
        // v$dataguard_status not accessible — just return the role
        if (dbRole === "PRIMARY") {
          return { role: "primary", lagSeconds: null, status: "healthy", errorMessage: null };
        }
        if (dbRole?.includes("STANDBY")) {
          return { role: "standby", lagSeconds: null, status: "healthy", errorMessage: null };
        }
        return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
      }
    } catch (e: any) {
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
      }
      return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: e.message ?? String(e) };
    } finally {
      await conn.close();
    }
  }

  async listServerVariables(engineId: string, config: EngineConfig): Promise<ServerVariable[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const result = await conn.execute(
        `SELECT name, value, description
         FROM v$parameter
         WHERE name IN (
           'sga_max_size', 'sga_target', 'pga_aggregate_target',
           'memory_target', 'processes', 'sessions', 'open_cursors',
           'db_block_size', 'db_cache_size', 'shared_pool_size',
           'large_pool_size', 'java_pool_size', 'log_buffer',
           'undo_tablespace', 'undo_retention', 'undo_management',
           'workarea_size_policy', 'parallel_max_servers',
           'parallel_degree_policy', 'optimizer_mode',
           'statistics_level', 'timed_statistics', 'db_recovery_file_dest_size',
           'archive_lag_target', 'log_archive_max_processes',
           'audit_trail', 'remote_login_passwordfile', 'os_authent_prefix',
           'max_dump_file_size', 'sql_trace', 'lock_sga'
         )
         ORDER BY name`
      );
      const rows = result.rows || [];
      return rows.map((row: any) => ({
        name: String(row[0] ?? ""),
        value: String(row[1] ?? ""),
        description: row[2] ? String(row[2]) : undefined,
      }));
    } catch (e: any) {
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return [];
      }
      throw e;
    } finally {
      await conn.close();
    }
  }

  async listServerStatus(engineId: string, config: EngineConfig): Promise<ServerStatusMetric[]> {
    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const result = await conn.execute(
        `SELECT name, value
         FROM v$sysstat
         WHERE name IN (
           'parse count (total)', 'parse count (hard)', 'parse count (failures)',
           'execute count', 'physical reads', 'physical reads cache',
           'physical reads direct', 'physical writes', 'physical writes direct',
           'redo size', 'redo entries', 'db block gets', 'consistent gets',
           'buffer cache hits', 'free buffer inspected', 'dirty buffers inspected',
           'session cursor cache hits', 'session cursor cache count',
           'user commits', 'user rollbacks', 'user calls', 'recursive calls',
           'logons cumulative', 'logons current', 'opened cursors cumulative',
           'opened cursors current', 'sorts (memory)', 'sorts (disk)', 'sorts (rows)',
           'enqueue requests', 'enqueue waits', 'enqueue deadlocks',
           'physical read IO requests', 'physical write IO requests'
         )
         ORDER BY name`
      );
      const rows = result.rows || [];
      return rows.map((row: any) => ({
        name: String(row[0] ?? ""),
        value: Number(row[1]) || 0,
      }));
    } catch (e: any) {
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return [];
      }
      throw e;
    } finally {
      await conn.close();
    }
  }
}

export const oracleConnector = new OracleConnector();