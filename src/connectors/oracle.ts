import oracledb from "oracledb";
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
} from "../connector.js";

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

  private async getPool(engineId: string, config: EngineConfig): Promise<any> {
    let pool = this.pools.get(engineId);
    if (!pool) {
      const cfg = config.url
        ? parseOracleUrl(config.url)
        : {
            user: config.user || "system",
            password: config.password || "",
            connectString: `${config.host || "localhost"}:${config.port || 1521}/${config.database || "XE"}`,
          };

      pool = await oracledb.createPool({
        user: cfg.user,
        password: cfg.password,
        connectString: cfg.connectString,
        poolMin: 1,
        poolMax: 5,
        poolIncrement: 1,
      });
      this.pools.set(engineId, pool);
    }
    return pool;
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
      try {
        const result = await conn.execute(
          `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '${stmtId}'))`,
          []
        );
        const rows = result.rows || [];
        plan = rows.map((r: any) => r[0]).join("\n");
      } catch {
        // DBMS_XPLAN might not be available — fallback to plan_table
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
      return { plan, format: "text", analyzed: false };
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

  async listSlowQueries(engineId: string, config: EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryInfo[]> {
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
          max_elapsed_time AS max_time_us,
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
      return rows.map((row: any) => ({
        id: `oracle-${row[0]}`,
        query: (row[1] ?? "").substring(0, 2000),
        executionCount: Number(row[2]) || undefined,
        totalExecutionTimeMs: Math.round(Number(row[3]) / 1000),
        avgExecutionTimeMs: row[4] ? Math.round(Number(row[4]) / 1000) : undefined,
        maxExecutionTimeMs: Math.round(Number(row[5]) / 1000),
        rowsReturned: Number(row[8]) || undefined,
      }));
    } catch (e: any) {
      // V$SQLAREA requires SELECT ANY DICTIONARY — return empty if no permission
      if (e.message?.includes("ORA-00942") || e.message?.includes("ORA-01031")) {
        return [];
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
        user: row[1] ?? "",
        host: row[2] ?? "",
        database: null,
        command: "query",
        time: row[4] ?? 0,
        state: row[3] ?? null,
        query: row[5] ?? null,
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

    const pool = await this.getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const result = await conn.execute(sql, [], { resultSet: false });
      const columns = (result.metaData || []).map((m: { name: string }) => m.name);
      const rows = (result.rows || []).map((row: any[]) => {
        const record: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
          record[columns[i]] = row[i];
        }
        return record;
      });
      return { columns, rows };
    } finally {
      await conn.close();
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
  }
}

export const oracleConnector = new OracleConnector();