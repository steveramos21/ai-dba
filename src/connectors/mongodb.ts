import { MongoClient, type Db } from "mongodb";
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

/**
 * Parse a mongodb:// connection URL.
 * mongodb://user:password@host:port/database?authSource=admin
 * The mongodb driver handles URLs natively, but we provide this for validation.
 */
export function parseMongoUrl(url: string): { uri: string; database: string } {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("mongodb")) {
      throw new Error("URL must start with mongodb:// or mongodb+srv://");
    }
    const database = parsed.pathname.slice(1) || "admin";
    return { uri: url, database };
  } catch {
    throw new Error(
      `Invalid MongoDB URL: ${url}\n` +
      `Expected: mongodb://user:password@host:port/database?authSource=admin`
    );
  }
}

export class MongoDbConnector implements DatabaseConnector {
  private clients: Map<string, MongoClient> = new Map();

  private async getClient(engineId: string, config: EngineConfig): Promise<{ client: MongoClient; db: Db; database: string }> {
    let client = this.clients.get(engineId);
    if (!client) {
      const { uri, database } = config.url
        ? parseMongoUrl(config.url)
        : { uri: `mongodb://${config.host || "localhost"}:${config.port || 27017}`, database: config.database || "admin" };

      client = new MongoClient(uri);
      await client.connect();
      this.clients.set(engineId, client);
      return { client, db: client.db(database), database };
    }
    // Extract database from URL for existing client
    const { database } = config.url ? parseMongoUrl(config.url) : { database: config.database || "admin" };
    return { client, db: client.db(database), database };
  }

  async listDatabases(engineId: string, config: EngineConfig): Promise<DatabaseInfo[]> {
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    const result = await admin.listDatabases();
    return result.databases.map((d: any) => ({
      name: d.name,
      sizeBytes: (d.sizeOnDisk ?? 0) > 0 ? d.sizeOnDisk : undefined,
    }));
  }

  async listTables(engineId: string, config: EngineConfig, database?: string): Promise<TableInfo[]> {
    const { client } = await this.getClient(engineId, config);
    const db = database ? client.db(database) : client.db();
    const collections = await db.listCollections().toArray();
    return collections.map((c: any) => ({
      name: c.name,
      schema: c.options?.schemaType ? String(c.options.schemaType) : undefined,
    }));
  }

  async describeTable(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<ColumnInfo[]> {
    const { client } = await this.getClient(engineId, config);
    const db = database ? client.db(database) : client.db();
    const collection = db.collection(tableName);

    // Sample up to 100 documents to infer schema
    const docs = await collection.find({}, { limit: 100 }).toArray();
    if (docs.length === 0) {
      // Empty collection — return _id at minimum
      return [{
        name: "_id",
        type: "ObjectId",
        nullable: false,
        isPrimary: true,
        isAutoIncrement: false,
        defaultValue: null,
      }];
    }

    // Union all field names across sampled docs
    const fieldMap = new Map<string, string>(); // field → inferred type
    for (const doc of docs) {
      for (const [key, value] of Object.entries(doc)) {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, inferType(value));
        }
      }
    }

    return Array.from(fieldMap.entries()).map(([name, type]) => ({
      name,
      type,
      nullable: name !== "_id",
      isPrimary: name === "_id",
      isAutoIncrement: false,
      defaultValue: null,
    }));
  }

  async listIndexes(engineId: string, config: EngineConfig, tableName: string, database?: string): Promise<IndexInfo[]> {
    const { client } = await this.getClient(engineId, config);
    const db = database ? client.db(database) : client.db();
    const collection = db.collection(tableName);
    const indexes = await collection.listIndexes().toArray();

    return indexes.map((idx) => ({
      name: idx.name,
      table: tableName,
      columns: Object.keys(idx.key || {}),
      isUnique: idx.unique === true || idx.name === "_id_",
      isPrimary: idx.name === "_id_",
      type: (idx.unique === true || idx.name === "_id_") ? "UNIQUE" : "BTREE",
    }));
  }

  async listProcesses(engineId: string, config: EngineConfig): Promise<ProcessInfo[]> {
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    const result = await admin.command({ currentOp: 1, $ownOps: false });

    const ops = result.inprog || [];
    return ops.map((op: any) => ({
      pid: op.opid || 0,
      user: op.client || "",
      host: op.client_s || "",
      database: op.ns || null,
      command: op.op || "command",
      time: op.secs_running || 0,
      state: op.active ? "active" : "idle",
      query: op.command ? JSON.stringify(op.command) : null,
    }));
  }

  async query(engineId: string, config: EngineConfig, sql: string): Promise<QueryResult> {
    // For MongoDB, "sql" is a JSON command document
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(sql);
    } catch {
      throw new Error("MongoDB query requires a JSON command document, e.g. {\"find\": \"collection\", \"filter\": {}}");
    }

    // Read-only guard: only allow find, aggregate, count, distinct
    const allowedOps = ["find", "aggregate", "count", "distinct", "ping"];
    const cmdKeys = Object.keys(cmd).filter((k) => !k.startsWith("$"));
    const isAllowed = cmdKeys.some((k) => allowedOps.includes(k));
    if (!isAllowed) {
      throw new Error(`Only read-only commands (${allowedOps.join(", ")}) are allowed for now.`);
    }

    const { client } = await this.getClient(engineId, config);

    if (cmd.ping) {
      const admin = client.db().admin();
      const result = await admin.ping();
      return { columns: ["ok"], rows: [{ ok: result.ok }] };
    }

    if (cmd.find) {
      const collection = String(cmd.find);
      const filter = (cmd.filter as Record<string, unknown>) || {};
      const limit = Number(cmd.limit) || 100;
      const db = client.db();
      const docs = await db.collection(collection).find(filter).limit(limit).toArray();
      const columns = docs.length > 0 ? Object.keys(docs[0]) : [];
      return { columns, rows: docs as Record<string, unknown>[] };
    }

    if (cmd.count) {
      const collection = String(cmd.count);
      const filter = (cmd.filter as Record<string, unknown>) || {};
      const db = client.db();
      const count = await db.collection(collection).countDocuments(filter);
      return { columns: ["count"], rows: [{ count }] };
    }

    if (cmd.distinct) {
      const collection = String(cmd.distinct);
      const field = String(cmd.field);
      const filter = (cmd.filter as Record<string, unknown>) || {};
      const db = client.db();
      const values = await db.collection(collection).distinct(field, filter);
      return { columns: [field], rows: values.map((v) => ({ [field]: v })) };
    }

    if (cmd.aggregate) {
      const collection = String(cmd.aggregate);
      const pipeline = (cmd.pipeline as any[]) || [];
      const db = client.db();
      const docs = await db.collection(collection).aggregate(pipeline).toArray();
      const columns = docs.length > 0 ? Object.keys(docs[0]) : [];
      return { columns, rows: docs as Record<string, unknown>[] };
    }

    throw new Error("Unsupported query command");
  }

  async getBlockingChains(engineId: string, config: EngineConfig): Promise<BlockingChain[]> {
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    const result = await admin.command({ currentOp: 1, $ownOps: false });

    const ops = (result.inprog || []).filter((op: any) => op.secs_running > 0 || op.waitingForLock);
    return ops.map((op: any) => ({
      engine_id: engineId,
      blocking_pid: 0, // MongoDB has no traditional row locks — 0 = no blocker
      blocked_pid: op.opid || 0,
      wait_duration_ms: (op.secs_running || 0) * 1000,
      wait_event: op.waitingForLock ? "waitingForLock" : "longRunning",
      blocking_query: null,
      blocked_query: op.command ? JSON.stringify(op.command) : null,
      database_name: op.ns || null,
      wait_type: op.lockStats ? "lock" : null,
      status: op.active ? "active" : "idle",
      host_name: op.client_s || null,
      program_name: null,
      login_time: null,
    }));
  }

  async closeAllPools(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }
}

function inferType(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return "Date";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "object") {
    // Check for MongoDB ObjectId by constructor name
    const ctor = value.constructor?.name;
    if (ctor === "ObjectId") return "ObjectId";
    if (ctor === "Decimal128") return "Decimal128";
    if (ctor === "Binary") return "Binary";
    return "object";
  }
  return typeof value;
}

export const mongodbConnector = new MongoDbConnector();