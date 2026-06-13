import pg, { type Pool, type QueryResult as PgQueryResult } from "pg";
import type { EngineConfig } from "../config.js";
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

  // Pass-through: hand the connection string directly to pg.Pool
  if (!config.url) {
    throw new Error(
      `PostgreSQL engine "${engineId}" requires a connection URL. ` +
      `Example: postgresql://user:***@host:5432/dbname`
    );
  }

  const pool = new pg.Pool({ connectionString: config.url });
  pools.set(engineId, pool);
  return pool;
}

// ─── PostgreSQL connector ──────────────────────────────────────

export class PostgreSQLConnector implements DatabaseConnector {
  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const pool = getPool(engineId, config);
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT datname AS name, pg_encoding_to_char(encoding) AS charset
         FROM pg_database
         WHERE datistemplate = false
         ORDER BY datname`
      );
      return result.rows.map((row) => ({
        name: row.name as string,
        charset: row.charset as string | undefined,
      }));
    } finally {
      client.release();
    }
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const pool = getPool(engineId, config);
    const client = await pool.connect();
    try {
      const schema = database || "public";
      const result = await client.query(
        `SELECT
           c.relname AS name,
           n.nspname AS schema,
           c.reltuples::bigint AS rows,
           pg_total_relation_size(c.oid) AS size_bytes,
           CASE WHEN c.relkind = 'm' THEN 'materialized_view'
                WHEN c.relkind = 'v' THEN 'view'
                ELSE 'heap' END AS engine,
           obj_description(c.oid) AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relkind IN ('r', 'm', 'v')
         ORDER BY c.relname`,
        [schema]
      );
      return result.rows.map((row) => ({
        name: row.name as string,
        schema: row.schema as string,
        rows: Number(row.rows) || undefined,
        sizeBytes: Number(row.size_bytes) || undefined,
        engine: row.engine as string,
        comment: row.comment as string | null ?? undefined,
      }));
    } finally {
      client.release();
    }
  }

  async describeTable(engineId: string, config: EngineConfig, table: string, database?: string): Promise<ColumnInfo[]> {
    const pool = getPool(engineId, config);
    const client = await pool.connect();
    try {
      const schema = database || "public";
      const result = await client.query(
        `SELECT
           a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
           (EXISTS (
             SELECT 1 FROM pg_catalog.pg_constraint con
             WHERE con.conrelid = c.oid
               AND con.contype = 'p'
               AND a.attnum = ANY(con.conkey)
           )) AS is_primary,
           a.atthasdef AS has_default
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
         WHERE n.nspname = $1
           AND c.relname = $2
           AND a.attnum > 0
           AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, table]
      );
      return result.rows.map((row) => ({
        name: row.name as string,
        type: row.type as string,
        nullable: row.nullable as boolean,
        defaultValue: row.default_value as string | null ?? (row.has_default ? "" : null),
        isPrimary: row.is_primary as boolean,
        isAutoIncrement: false, // PostgreSQL uses SERIAL/BIGSERIAL, not auto_increment
        comment: undefined,
      }));
    } finally {
      client.release();
    }
  }

  async listIndexes(engineId: string, config: EngineConfig, table: string, database?: string): Promise<IndexInfo[]> {
    const pool = getPool(engineId, config);
    const client = await pool.connect();
    try {
      const schema = database || "public";
      const result = await client.query(
        `SELECT
           ic.relname AS index_name,
           i.indisunique AS is_unique,
           i.indisprimary AS is_primary,
           am.amname AS index_type,
           array_agg(a.attname ORDER BY k.n) AS columns
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_catalog.pg_am am ON am.oid = ic.relam
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE n.nspname = $1
           AND c.relname = $2
         GROUP BY ic.relname, i.indisunique, i.indisprimary, am.amname
         ORDER BY ic.relname`,
        [schema, table]
      );
      return result.rows.map((row) => ({
        name: row.index_name as string,
        table,
        columns: row.columns as string[],
        isUnique: row.is_unique as boolean,
        isPrimary: row.is_primary as boolean,
        type: row.index_type as string,
      }));
    } finally {
      client.release();
    }
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const pool = getPool(engineId, config);
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
           pid,
           usename AS user,
           client_addr AS host,
           datname AS database,
           state AS command,
           EXTRACT(EPOCH FROM now() - query_start)::int AS time,
           state,
           query
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()`
      );
      return result.rows.map((row) => ({
        pid: row.pid as number,
        user: row.user as string,
        host: row.host as string,
        database: row.database as string | null,
        command: row.command as string,
        time: row.time as number,
        state: row.state as string | null,
        query: row.query as string | null,
      }));
    } finally {
      client.release();
    }
  }

  async query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult> {
    const pool = getPool(engineId, config);
    const client = await pool.connect();
    try {
      const result: PgQueryResult = await client.query(sql);

      // Result with rows
      if (result.rows && result.rows.length > 0) {
        const columns = Object.keys(result.rows[0]);
        return {
          columns,
          rows: result.rows.map((row) => {
            const obj: Record<string, unknown> = {};
            for (const col of columns) {
              obj[col] = row[col];
            }
            return obj;
          }),
        };
      }

      // DML statements (INSERT, UPDATE, DELETE) — has rowCount but no rows
      if ((result.rowCount !== undefined && result.rowCount !== null) && result.rows?.length === 0 && (!result.fields || result.fields.length === 0)) {
        return {
          columns: ["affectedRows"],
          rows: [{ affectedRows: result.rowCount }],
          affectedRows: result.rowCount,
        };
      }

      // Empty result set with known columns (e.g., SELECT that returns 0 rows)
      if (result.fields && result.fields.length > 0) {
        return {
          columns: result.fields.map((f) => f.name),
          rows: [],
        };
      }

      return { columns: [], rows: [] };
    } finally {
      client.release();
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

// Singleton export for REPL to use
export const postgresConnector = new PostgreSQLConnector();

/** Close all PostgreSQL connection pools. */
export const closeAllPools = () => postgresConnector.closeAllPools();