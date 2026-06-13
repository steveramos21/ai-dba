import mysql, { type Pool, type PoolConnection, type RowDataPacket, type SslOptions } from "mysql2/promise";
import type { EngineConfig } from "../config.js";
import { resolveMysqlConfig } from "../config.js";
import type { BlockingChain } from "../types.js";

/**
 * Lazy connection pool for MySQL.
 * Created on first use, reused for subsequent calls.
 */

const pools = new Map<string, Pool>();

function getPool(engineId: string, config: EngineConfig): Pool {
  const existing = pools.get(engineId);
  if (existing) return existing;

  const resolved = resolveMysqlConfig(engineId, config);
  // mysql2 expects ssl as string | SslOptions, not boolean
  // ssl=true means VERIFY_IDENTITY, any other ssl value passes through
  const ssl = resolved.ssl === true ? "VERIFY_IDENTITY" as string : resolved.ssl as SslOptions | string | undefined;
  const { ssl: _ssl, ...rest } = resolved;
  const poolConfig: mysql.PoolOptions = {
    ...rest,
    ssl,
  };
  const pool = mysql.createPool(poolConfig);

  pools.set(engineId, pool);
  return pool;
}

/**
 * Close all pools. Call on server shutdown.
 */
export async function closeAllPools(): Promise<void> {
  const closers: Promise<void>[] = [];
  for (const [id, pool] of pools) {
    closers.push(pool.end().then(() => { pools.delete(id); }));
  }
  await Promise.all(closers);
}

/**
 * Check if performance_schema is enabled on the target MySQL instance.
 */
async function checkPerformanceSchema(conn: PoolConnection): Promise<boolean> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    "SELECT @@performance_schema AS enabled"
  );
  return rows[0]?.enabled === 1;
}

/**
 * Get blocking chains from MySQL using performance_schema.
 *
 * Uses data_lock_waits (MySQL 8.0+) to find lock relationships,
 * joined with threads and events_statements_current for session and query info.
 */
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