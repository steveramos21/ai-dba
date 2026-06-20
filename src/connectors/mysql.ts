import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { EngineConfig } from "../config.js";
import type {
  DatabaseConnector,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ProcessInfo,
  QueryResult,
  BlockingChain,
} from "../connector.js";

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

  async listTables(engineId: string, config: EngineConfig): Promise<TableInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT TABLE_NAME as name, TABLE_ROWS as `rows`, DATA_LENGTH as sizeBytes, ENGINE as engine, TABLE_COLLATION as collation FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
        [config.database]
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

  async describeTable(engineId: string, config: EngineConfig, tableName: string): Promise<ColumnInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
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
        [config.database, tableName]
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

  async listIndexes(engineId: string, config: EngineConfig, tableName: string): Promise<IndexInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
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
        [config.database, tableName]
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

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const pool = this.getPool(engineId, config);
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT ID as pid, USER as user, HOST as host, DB as database, COMMAND as command, TIME as time, STATE as state, INFO as query FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID != CONNECTION_ID()"
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
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
          r.trx_mysql_thread_id as blocking_pid,
          r.trx_mysql_thread_id as blocked_pid,
          r.trx_state as wait_event,
          r.trx_tables_locked as database_name,
          r.trx_query as blocking_query,
          r.trx_query as blocked_query
        FROM INFORMATION_SCHEMA.INNODB_LOCK_WAITS w
        JOIN INFORMATION_SCHEMA.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
        JOIN INFORMATION_SCHEMA.INNODB_TRX r ON r.trx_id = w.requesting_trx_id`
      );
      return rows.map((row: any) => ({
        engine_id: engineId,
        blocking_pid: row.blocking_pid,
        blocked_pid: row.blocked_pid,
        wait_duration_ms: null,
        wait_event: row.wait_event ?? null,
        blocking_query: row.blocking_query ?? null,
        blocked_query: row.blocked_query ?? null,
        database_name: row.database_name ?? null,
        wait_type: null,
        status: null,
        host_name: null,
        program_name: null,
        login_time: null,
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
}

export const mysqlConnector = new MySQLConnector();
