import pg, { type Pool } from "pg";
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

  async listTables(engineId: string, config: EngineConfig): Promise<TableInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT tablename as name, schemaname as schema FROM pg_tables WHERE schemaname = ANY(current_schemas(false))"
      );
      return res.rows.map((row: any) => ({
        name: row.name,
        schema: row.schema,
      }));
    } finally {
      client.release();
    }
  }

  async describeTable(engineId: string, config: EngineConfig, tableName: string): Promise<ColumnInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      let schema = "public";
      let table = tableName;
      if (tableName.includes(".")) {
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

  async listIndexes(engineId: string, config: EngineConfig, tableName: string): Promise<IndexInfo[]> {
    const pool = this.getPool(engineId, config);
    const client = await pool.connect();
    try {
      let schema = "public";
      let table = tableName;
      if (tableName.includes(".")) {
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

  async getBlockingChains(_engineId: string, _config: EngineConfig): Promise<BlockingChain[]> {
    throw new Error("getBlockingChains() not yet implemented for PostgreSQL");
  }

  async closeAllPools(): Promise<void> {
    for (const pool of this.pools.values()) {
      await pool.end();
    }
    this.pools.clear();
  }
}

export const postgresConnector = new PostgreSQLConnector();
