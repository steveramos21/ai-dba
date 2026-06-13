import mysql, { type Pool, type PoolConnection, type RowDataPacket, type SslOptions } from "mysql2/promise";
import type { EngineConfig } from "../config.js";
import { resolveMysqlConfig } from "../config.js";
import type { BlockingChain } from "../types.js";
import type {
  DatabaseConnector,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ProcessInfo,
  QueryResult,
} from "../connector.js";

// ─── Lazy pool management ─────────────────────────────────────

const pools = new Map<string, Pool>();

function getPool(engineId: string, config: EngineConfig): Pool {
  const existing = pools.get(engineId);
  if (existing) return existing;

  const resolved = resolveMysqlConfig(engineId, config);
  const ssl = resolved.ssl === true ? ("VERIFY_IDENTITY" as string) : (resolved.ssl as SslOptions | string | undefined);
  const { ssl: _ssl, ...rest } = resolved;
  const poolConfig: mysql.PoolOptions = { ...rest, ssl };
  const pool = mysql.createPool(poolConfig);

  pools.set(engineId, pool);
  return pool;
}

// ─── MySQL connector ───────────────────────────────────────────

export class MySQLConnector implements DatabaseConnector {
  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const pool = getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute<RowDataPacket[]>("SHOW DATABASES");
      return rows.map((row) => ({
        name: row.Database as string,
      }));
    } finally {
      conn.release();
    }
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const pool = getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      if (database) {
        await conn.execute(`USE ??`, [database]);
      }
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, ENGINE, TABLE_COLLATION, TABLE_COMMENT
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()`
      );
      return rows.map((row) => ({
        name: row.TABLE_NAME as string,
        rows: row.TABLE_ROWS as number,
        sizeBytes: row.DATA_LENGTH as number,
        engine: row.ENGINE as string,
        collation: row.TABLE_COLLATION as string,
        comment: row.TABLE_COMMENT as string,
      }));
    } finally {
      conn.release();
    }
  }

  async describeTable(engineId: string, config: EngineConfig, table: string, database?: string): Promise<ColumnInfo[]> {
    const pool = getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      if (database) {
        await conn.execute(`USE ??`, [database]);
      }
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [table]
      );
      return rows.map((row) => ({
        name: row.COLUMN_NAME as string,
        type: row.COLUMN_TYPE as string,
        nullable: row.IS_NULLABLE === "YES",
        defaultValue: row.COLUMN_DEFAULT as string | null,
        isPrimary: row.COLUMN_KEY === "PRI",
        isAutoIncrement: (row.EXTRA as string).includes("auto_increment"),
        comment: row.COLUMN_COMMENT as string,
      }));
    } finally {
      conn.release();
    }
  }

  async listIndexes(engineId: string, config: EngineConfig, table: string, database?: string): Promise<IndexInfo[]> {
    const pool = getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      if (database) {
        await conn.execute(`USE ??`, [database]);
      }
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX, INDEX_TYPE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [table]
      );
      // Group by index name
      const indexMap = new Map<string, { columns: string[]; isUnique: boolean; type: string }>();
      for (const row of rows) {
        const idxName = row.INDEX_NAME as string;
        if (!indexMap.has(idxName)) {
          indexMap.set(idxName, {
            columns: [],
            isUnique: !(row.NON_UNIQUE as number),
            type: row.INDEX_TYPE as string,
          });
        }
        indexMap.get(idxName)!.columns.push(row.COLUMN_NAME as string);
      }
      return Array.from(indexMap.entries()).map(([name, info]) => ({
        name,
        table,
        columns: info.columns,
        isUnique: info.isUnique,
        isPrimary: name === "PRIMARY",
        type: info.type,
      }));
    } finally {
      conn.release();
    }
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const pool = getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute<RowDataPacket[]>("SHOW PROCESSLIST");
      return rows.map((row) => ({
        pid: row.Id as number,
        user: row.User as string,
        host: row.Host as string,
        database: row.db as string | null,
        command: row.Command as string,
        time: row.Time as number,
        state: row.State as string | null,
        query: row.Info as string | null,
      }));
    } finally {
      conn.release();
    }
  }

  async query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult> {
    const pool = getPool(engineId, config);
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.execute(sql);

      if (Array.isArray(result)) {
        const rows = result as RowDataPacket[];
        if (rows.length === 0) {
          return { columns: [], rows: [] };
        }
        const columns = Object.keys(rows[0]);
        return {
          columns,
          rows: rows.map((row) => {
            const obj: Record<string, unknown> = {};
            for (const col of columns) {
              obj[col] = (row as Record<string, unknown>)[col];
            }
            return obj;
          }),
        };
      }

      const ok = result as { affectedRows?: number; insertId?: number; changedRows?: number };
      return {
        columns: ["affectedRows", "insertId", "changedRows"],
        rows: [{ affectedRows: ok.affectedRows ?? 0, insertId: ok.insertId ?? 0, changedRows: ok.changedRows ?? 0 }],
        affectedRows: ok.affectedRows,
      };
    } finally {
      conn.release();
    }
  }

  async closeAllPools(): Promise<void> {
    const closers: Promise<void>[] = [];
    for (const [id, pool] of pools) {
      closers.push(pool.end().then(() => { pools.delete(id); }));
    }
    await Promise.all(closers);
  }
}

// ─── Legacy exports (blocking-chains tool still uses these) ────

const connector = new MySQLConnector();

/** Close all MySQL connection pools. */
export const closeAllPools = () => connector.closeAllPools();

/** @deprecated Use connector.listProcesses() instead */
export async function getBlockingChainsMySQL(
  engineId: string,
  config: EngineConfig
): Promise<BlockingChain[]> {
  const pool = getPool(engineId, config);
  const conn = await pool.getConnection();

  try {
    const psEnabled = await checkPerformanceSchema(conn);
    if (!psEnabled) {
      const resolved = resolveMysqlConfig(engineId, config);
      throw new Error(
        `MySQL engine "${engineId}" (${resolved.host}:${resolved.port}): ` +
        `performance_schema is DISABLED. Enable it with SET GLOBAL performance_schema=ON and restart MySQL.`
      );
    }

    const [rows] = await conn.execute<RowDataPacket[]>(`
      SELECT
        blocking_th.PROCESSLIST_ID AS blocking_pid,
        requesting_th.PROCESSLIST_ID AS blocked_pid,
        dlw.REQUESTING_ENGINE_TRANSACTION_ID AS requesting_trx_id,
        dlw.BLOCKING_ENGINE_TRANSACTION_ID AS blocking_trx_id,
        blocking_sql.SQL_TEXT AS blocking_query,
        blocked_sql.SQL_TEXT AS blocked_query,
        requesting_th.PROCESSLIST_DB AS database_name,
        requesting_th.PROCESSLIST_STATE AS status,
        requesting_th.PROCESSLIST_HOST AS host_name,
        blocking_th.PROCESSLIST_COMMAND AS blocking_command,
        blocking_th.PROCESSLIST_TIME AS blocking_time_sec,
        requesting_th.PROCESSLIST_COMMAND AS blocked_command
      FROM performance_schema.data_lock_waits dlw
      INNER JOIN performance_schema.threads blocking_th
        ON dlw.BLOCKING_THREAD_ID = blocking_th.THREAD_ID
      INNER JOIN performance_schema.threads requesting_th
        ON dlw.REQUESTING_THREAD_ID = requesting_th.THREAD_ID
      LEFT JOIN performance_schema.events_statements_current blocking_sql
        ON blocking_th.THREAD_ID = blocking_sql.THREAD_ID
      LEFT JOIN performance_schema.events_statements_current blocked_sql
        ON requesting_th.THREAD_ID = blocked_sql.THREAD_ID
    `);

    return rows.map((row) => ({
      engine_id: engineId,
      blocking_pid: row.blocking_pid ?? 0,
      blocked_pid: row.blocked_pid ?? 0,
      wait_duration_ms: 0,
      wait_event: "lock_wait",
      blocking_query: row.blocking_query ?? null,
      blocked_query: row.blocked_query ?? null,
      database_name: row.database_name ?? null,
      wait_type: row.blocking_command ? `${row.blocking_command} holding lock` : null,
      status: row.status ?? null,
      host_name: row.host_name ?? null,
      program_name: row.blocked_command ?? null,
      login_time: row.blocking_time_sec != null ? `${row.blocking_time_sec}s` : null,
    }));
  } finally {
    conn.release();
  }
}

async function checkPerformanceSchema(conn: PoolConnection): Promise<boolean> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    "SELECT @@performance_schema AS enabled"
  );
  return rows[0]?.enabled === 1;
}

// Singleton export for REPL to use
export const mysqlConnector = connector;