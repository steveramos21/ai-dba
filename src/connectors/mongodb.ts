import { MongoClient, type Db } from "mongodb";
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

  async listTableSizes(engineId: string, config: EngineConfig, database?: string): Promise<TableSizeInfo[]> {
    const { client, db: defaultDb } = await this.getClient(engineId, config);
    const targetDb = database ? client.db(database) : defaultDb;
    const collections = await targetDb.listCollections().toArray();
    const sizes: TableSizeInfo[] = [];
    for (const col of collections) {
      try {
        const stats = await targetDb.command({ collStats: col.name }) as any;
        sizes.push({
          name: col.name,
          rows: stats.count ?? undefined,
          dataSizeBytes: stats.size ?? 0,
          indexSizeBytes: stats.totalIndexSize ?? 0,
          totalSizeBytes: (stats.size ?? 0) + (stats.totalIndexSize ?? 0),
        });
      } catch {
        // Skip collections we can't stat (e.g., views)
      }
    }
    sizes.sort((a, b) => (b.totalSizeBytes ?? 0) - (a.totalSizeBytes ?? 0));
    return sizes;
  }

  async explainQuery(engineId: string, config: EngineConfig, query: string, options?: ExplainOptions): Promise<ExplainResult> {
    const analyze = options?.analyze ?? false;
    const { client, db } = await this.getClient(engineId, config);

    // MongoDB: `query` is a JSON command document like {"find": "users", "filter": {}}
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(query);
    } catch {
      throw new Error("MongoDB explain requires a JSON command document, e.g. {\"find\": \"collection\", \"filter\": {}}");
    }

    if (!cmd.find && !cmd.aggregate && !cmd.count && !cmd.distinct) {
      throw new Error("MongoDB explain JSON must contain a 'find', 'aggregate', 'count', or 'distinct' key");
    }

    const verbosity = analyze ? "executionStats" : "queryPlanner";

    let explainCmd: Record<string, unknown>;
    if (cmd.find) {
      explainCmd = { explain: { find: cmd.find, filter: cmd.filter || {} }, verbosity };
    } else if (cmd.aggregate) {
      explainCmd = { explain: { aggregate: cmd.aggregate, pipeline: cmd.pipeline || [], cursor: {} }, verbosity };
    } else if (cmd.count) {
      explainCmd = { explain: { count: cmd.count, query: cmd.filter || {} }, verbosity };
    } else if (cmd.distinct) {
      explainCmd = { explain: { distinct: cmd.distinct, key: cmd.field, query: cmd.filter || {} }, verbosity };
    } else {
      throw new Error("Unsupported command for explain");
    }

    const result = await db.command(explainCmd as any);
    return { plan: JSON.stringify(result, null, 2), format: "json", analyzed: analyze };
  }

  async listSlowQueries(engineId: string, config: EngineConfig, options?: SlowQueryOptions): Promise<SlowQueryInfo[]> {
    const limit = options?.limit ?? 10;
    const minDurationMs = options?.minDurationMs ?? 1000;
    const minDurationSec = minDurationMs / 1000;
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    try {
      const result = await admin.command({ currentOp: 1, $ownOps: false, secs_running: { $gte: minDurationSec } });
      const ops = (result.inprog || []).slice(0, limit);
      return ops.map((op: any, i: number) => ({
        id: `mongo-${op.opid ?? i}`,
        query: op.command ? JSON.stringify(op.command).substring(0, 2000) : "",
        database: op.ns ?? undefined,
        totalExecutionTimeMs: Math.round((op.secs_running || 0) * 1000),
        executionCount: undefined,
        maxExecutionTimeMs: undefined,
      }));
    } catch {
      // currentOp may require privileges — return empty
      return [];
    }
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

    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    const command = `db.killOp(${pidNum})`;

    try {
      // Look up the operation — currentOp doesn't support opid as a filter parameter,
      // so we fetch all ops and filter client-side
      const result = await admin.command({ currentOp: 1, $ownOps: false });
      const ops = (result.inprog || []).filter((op: any) => op.opid === pidNum);
      const proc = ops[0] as any;

      const queryTrunc = proc?.command ? JSON.stringify(proc.command).substring(0, 500) : undefined;
      const durationStr = proc ? `${Math.round((proc.secs_running || 0) * 1000)}ms` : undefined;

      // Process not found
      if (!proc) {
        if (dryRun) {
          return { success: false, found: false, wouldKill: true, pid, engineId, command, notes: "Process not found — may have terminated independently" };
        }
        // Try to kill anyway
        try {
          await admin.command({ killOp: 1, op: pidNum });
        } catch { /* ignore — op already gone */ }
        return { success: true, found: false, pid, engineId, command, killedAt: new Date().toISOString(), notes: "Process not found — may have terminated independently" };
      }

      // Dry-run: return proposal
      if (dryRun) {
        return {
          success: false, found: true, wouldKill: true, pid, engineId,
          user: proc.client ?? undefined, database: proc.ns ?? undefined,
          duration: durationStr, query: queryTrunc, command,
        };
      }

      // Execute the kill
      try {
        await admin.command({ killOp: 1, op: pidNum });
        const killedAt = new Date().toISOString();

        writeAuditEntry({
          timestamp: killedAt, action: "kill-process", engineId, pid,
          user: proc.client, database: proc.ns ?? undefined,
          duration: durationStr, query: queryTrunc, command,
          success: true, killedAt,
        });

        return { success: true, found: true, pid, engineId, user: proc.client, database: proc.ns ?? undefined, duration: durationStr, query: queryTrunc, command, killedAt };
      } catch (e: any) {
        const error = e.message ?? String(e);
        writeAuditEntry({
          timestamp: new Date().toISOString(), action: "kill-process", engineId, pid,
          user: proc.client, database: proc.ns ?? undefined,
          duration: durationStr, query: queryTrunc, command,
          success: false, error,
        });
        return { success: false, found: true, pid, engineId, user: proc.client, database: proc.ns ?? undefined, duration: durationStr, query: queryTrunc, command, error };
      }
    } catch (e: any) {
      // currentOp may require privileges
      if (dryRun) {
        return { success: false, found: false, wouldKill: true, pid, engineId, command, notes: "Cannot query currentOp — may lack privileges" };
      }
      // Try to kill anyway — but be honest about the blind execution
      try {
        await admin.command({ killOp: 1, op: pidNum });
        return { success: true, found: false, pid, engineId, command, killedAt: new Date().toISOString(), notes: "Could not verify process before kill — killOp sent without currentOp verification" };
      } catch (e2: any) {
        return { success: false, found: false, pid, engineId, command, error: `Cannot query currentOp: ${e.message}. killOp also failed: ${e2.message ?? String(e2)}` };
      }
    }
  }

  async listReplicationStatus(engineId: string, config: EngineConfig): Promise<ReplicationStatus> {
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    try {
      const result = await admin.command({ replSetGetStatus: 1 }) as any;

      // Identify this node's role
      const myState = result.myState;
      // MongoDB states: 1=PRIMARY, 2=SECONDARY, 3=RECOVERING, etc.
      let role = "none";
      if (myState === 1) role = "primary";
      else if (myState === 2) role = "secondary";
      else if (myState === 3) role = "recovering";
      else role = `state_${myState}`;

      // Calculate lag from members
      let maxLag = 0;
      let hasError = false;
      const members = result.members || [];
      for (const m of members) {
        if (m.health === 0) hasError = true;
        if (m.optimeDate && result.date) {
          const lag = Math.floor((result.date.getTime() - m.optimeDate.getTime()) / 1000);
          if (lag > maxLag) maxLag = lag;
        }
      }

      if (hasError) {
        return { role, lagSeconds: maxLag, status: "down", errorMessage: "One or more replica set members are down" };
      }
      if (maxLag > 60) {
        return { role, lagSeconds: maxLag, status: "degraded", errorMessage: null };
      }

      return { role, lagSeconds: maxLag, status: "healthy", errorMessage: null };
    } catch (e: any) {
      // Not a replica set or no permission
      const msg = e.message ?? String(e);
      if (msg.includes("not running with --replSet") || msg.includes("no replset config") ||
          msg.includes("NotYetInitialized") || msg.includes("no such command") ||
          msg.includes("unauthorized") || msg.code === 76 || msg.code === 13) {
        return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: null };
      }
      return { role: "none", lagSeconds: null, status: "not_configured", errorMessage: msg };
    }
  }

  async listServerVariables(engineId: string, config: EngineConfig): Promise<ServerVariable[]> {
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    try {
      const result = await admin.command({ serverStatus: 1 }) as any;
      const vars: ServerVariable[] = [];

      // Version info
      if (result.version) vars.push({ name: "version", value: result.version });
      if (result.process) vars.push({ name: "process", value: result.process });
      if (result.host) vars.push({ name: "host", value: result.host });
      if (result.uptime != null) vars.push({ name: "uptime_seconds", value: String(result.uptime) });

      // Connections
      const conn = result.connections || {};
      vars.push({ name: "current_connections", value: String(conn.current ?? 0) });
      vars.push({ name: "available_connections", value: String(conn.available ?? 0) });
      vars.push({ name: "total_created", value: String(conn.totalCreated ?? 0) });

      // Storage engine
      if (result.storageEngine) {
        vars.push({ name: "storage_engine", value: result.storageEngine.name ?? "unknown" });
      }

      // Oplog
      if (result.oplog) {
        vars.push({ name: "oplog_size_mb", value: String(Math.round((result.oplog.windowSize || 0))) });
      }

      // Network
      const net = result.network || {};
      vars.push({ name: "bytes_in", value: String(net.bytesIn ?? 0) });
      vars.push({ name: "bytes_out", value: String(net.bytesOut ?? 0) });

      // Memory
      const mem = result.mem || {};
      vars.push({ name: "resident_mb", value: String(mem.resident ?? 0) });
      vars.push({ name: "virtual_mb", value: String(mem.virtual ?? 0) });
      vars.push({ name: "mapped_mb", value: String(mem.mapped ?? 0) });

      return vars.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async listServerStatus(engineId: string, config: EngineConfig): Promise<ServerStatusMetric[]> {
    const { client } = await this.getClient(engineId, config);
    const admin = client.db().admin();
    try {
      const result = await admin.command({ serverStatus: 1 }) as any;
      const metrics: ServerStatusMetric[] = [];

      // Connections
      const conn = result.connections || {};
      metrics.push({ name: "current_connections", value: Number(conn.current ?? 0) });
      metrics.push({ name: "available_connections", value: Number(conn.available ?? 0) });

      // Operations
      const opcounters = result.opcounters || {};
      metrics.push({ name: "inserts", value: Number(opcounters.insert ?? 0) });
      metrics.push({ name: "queries", value: Number(opcounters.query ?? 0) });
      metrics.push({ name: "updates", value: Number(opcounters.update ?? 0) });
      metrics.push({ name: "deletes", value: Number(opcounters.delete ?? 0) });
      metrics.push({ name: "getmores", value: Number(opcounters.getmore ?? 0) });
      metrics.push({ name: "commands", value: Number(opcounters.command ?? 0) });

      // Network
      const net = result.network || {};
      metrics.push({ name: "bytes_in", value: Number(net.bytesIn ?? 0) });
      metrics.push({ name: "bytes_out", value: Number(net.bytesOut ?? 0) });
      metrics.push({ name: "num_requests", value: Number(net.numRequests ?? 0) });

      // Memory
      const mem = result.mem || {};
      metrics.push({ name: "resident_mb", value: Number(mem.resident ?? 0) });
      metrics.push({ name: "virtual_mb", value: Number(mem.virtual ?? 0) });

      // Document metrics
      const docMetrics = result.metrics?.document || {};
      metrics.push({ name: "documents_returned", value: Number(docMetrics.returned ?? 0) });
      metrics.push({ name: "documents_inserted", value: Number(docMetrics.inserted ?? 0) });
      metrics.push({ name: "documents_updated", value: Number(docMetrics.updated ?? 0) });
      metrics.push({ name: "documents_deleted", value: Number(docMetrics.deleted ?? 0) });

      // Index metrics
      const idxMetrics = result.indexCounter || result.metrics?.indexes || {};
      metrics.push({ name: "index_accesses", value: Number(idxMetrics.accesses ?? 0) });
      metrics.push({ name: "index_hits", value: Number(idxMetrics.hits ?? 0) });
      metrics.push({ name: "index_misses", value: Number(idxMetrics.misses ?? 0) });

      // Query execution time
      if (result.opLatencies) {
        metrics.push({ name: "read_latency_us", value: Number(result.opLatencies.reads?.latency ?? 0) });
        metrics.push({ name: "write_latency_us", value: Number(result.opLatencies.writes?.latency ?? 0) });
        metrics.push({ name: "command_latency_us", value: Number(result.opLatencies.commands?.latency ?? 0) });
      }

      return metrics.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
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