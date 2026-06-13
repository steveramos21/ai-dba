import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostgreSQLConnector } from "./postgres.js";
import type { EngineConfig } from "../config.js";

// ─── Mock pg module ────────────────────────────────────────────

const mockRows = vi.fn();
const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();

const mockPool = {
  connect: mockConnect,
  query: mockQuery,
  end: mockEnd,
  on: vi.fn(),
};

vi.mock("pg", () => ({
  default: { Pool: vi.fn(() => mockPool) },
  Pool: vi.fn(() => mockPool),
}));

const PG_CONFIG: EngineConfig = {
  type: "postgres",
  url: "postgresql://postgres:testpassword@127.0.0.1:15432/testdb",
};

function setupClient(rows: Record<string, unknown>[] = [], fields?: { name: string }[]) {
  const client = {
    query: mockQuery,
    release: mockRelease,
  };
  mockConnect.mockResolvedValue(client);
  mockQuery.mockResolvedValue({
    rows,
    fields: fields ?? (rows.length > 0 ? Object.keys(rows[0]).map((n) => ({ name: n })) : []),
    rowCount: rows.length,
  });
  mockRelease.mockReturnValue(undefined);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the pools map by creating a new connector
});

describe("PostgreSQLConnector", () => {
  const connector = new PostgreSQLConnector();

  describe("listDatabases", () => {
    it("should list non-template databases", async () => {
      setupClient([
        { name: "testdb", charset: "UTF8" },
        { name: "myapp", charset: "UTF8" },
      ]);

      const result = await connector.listDatabases("pg-test", PG_CONFIG);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: "testdb", charset: "UTF8" });
      expect(result[1]).toEqual({ name: "myapp", charset: "UTF8" });
      // listDatabases query has no parameters
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("pg_database"),
      );
    });

    it("should return empty array when no databases", async () => {
      setupClient([]);

      const result = await connector.listDatabases("pg-test", PG_CONFIG);
      expect(result).toHaveLength(0);
    });
  });

  describe("listTables", () => {
    it("should list tables in a schema", async () => {
      setupClient([
        { name: "users", schema: "public", rows: 100, size_bytes: 8192, engine: "heap", comment: null },
        { name: "orders", schema: "public", rows: 5000, size_bytes: 32768, engine: "heap", comment: "Order data" },
      ]);

      const result = await connector.listTables("pg-test", PG_CONFIG, "public");

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("users");
      expect(result[0].schema).toBe("public");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["public"]
      );
    });

    it("should default to public schema when no database specified", async () => {
      setupClient([]);

      await connector.listTables("pg-test", PG_CONFIG);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["public"]
      );
    });
  });

  describe("describeTable", () => {
    it("should describe columns of a table", async () => {
      setupClient([
        {
          name: "id",
          type: "integer",
          nullable: false,
          default_value: "nextval('users_id_seq'::regclass)",
          is_primary: true,
          has_default: true,
        },
        {
          name: "email",
          type: "character varying(255)",
          nullable: false,
          default_value: null,
          is_primary: false,
          has_default: false,
        },
      ]);

      const result = await connector.describeTable("pg-test", PG_CONFIG, "users", "public");

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        name: "id",
        type: "integer",
        nullable: false,
        isPrimary: true,
        isAutoIncrement: false,
      });
      expect(result[1]).toMatchObject({
        name: "email",
        type: "character varying(255)",
        nullable: false,
        isPrimary: false,
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["public", "users"]
      );
    });
  });

  describe("listIndexes", () => {
    it("should list indexes for a table", async () => {
      setupClient([
        {
          index_name: "users_pkey",
          is_unique: true,
          is_primary: true,
          index_type: "btree",
          columns: ["id"],
        },
        {
          index_name: "users_email_idx",
          is_unique: true,
          is_primary: false,
          index_type: "btree",
          columns: ["email"],
        },
      ]);

      const result = await connector.listIndexes("pg-test", PG_CONFIG, "users", "public");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: "users_pkey",
        table: "users",
        columns: ["id"],
        isUnique: true,
        isPrimary: true,
        type: "btree",
      });
      expect(result[1]).toEqual({
        name: "users_email_idx",
        table: "users",
        columns: ["email"],
        isUnique: true,
        isPrimary: false,
        type: "btree",
      });
    });
  });

  describe("listProcesses", () => {
    it("should list active processes", async () => {
      setupClient([
        {
          pid: 123,
          user: "postgres",
          host: "127.0.0.1",
          database: "testdb",
          command: "active",
          time: 5,
          state: "idle",
          query: "SELECT 1",
        },
      ]);

      const result = await connector.listProcesses("pg-test", PG_CONFIG);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        pid: 123,
        user: "postgres",
        host: "127.0.0.1",
        database: "testdb",
        command: "active",
        time: 5,
        state: "idle",
        query: "SELECT 1",
      });
    });
  });

  describe("query", () => {
    it("should return rows for SELECT queries", async () => {
      setupClient([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);

      const result = await connector.query("pg-test", PG_CONFIG, "SELECT * FROM users");

      expect(result.columns).toEqual(["id", "name"]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ id: 1, name: "Alice" });
    });

    it("should return affectedRows for DML statements", async () => {
      const client = {
        query: mockQuery,
        release: mockRelease,
      };
      mockConnect.mockResolvedValue(client);
      mockQuery.mockResolvedValue({
        rows: [],
        fields: [],
        rowCount: 3,
      });
      mockRelease.mockReturnValue(undefined);

      const result = await connector.query("pg-test", PG_CONFIG, "DELETE FROM users WHERE active = false");

      expect(result.affectedRows).toBe(3);
      expect(result.rows).toEqual([{ affectedRows: 3 }]);
    });

    it("should return empty result set for empty query results", async () => {
      const client = {
        query: mockQuery,
        release: mockRelease,
      };
      mockConnect.mockResolvedValue(client);
      // pg returns fields but 0 rows for a SELECT that matches nothing
      mockQuery.mockResolvedValue({
        rows: [],
        fields: [{ name: "id" }, { name: "name" }],
        rowCount: 0,
      });
      mockRelease.mockReturnValue(undefined);

      const result = await connector.query("pg-test", PG_CONFIG, "SELECT * FROM users WHERE 1=0");

      expect(result.columns).toEqual(["id", "name"]);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe("URL detection in parseUrlToEngine", () => {
    // Test the URL masking regex directly
    it("should mask password in postgresql:// URL", () => {
      const url = "postgresql://postgres:secretpass@127.0.0.1:5432/mydb";
      const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
      expect(masked).toBe("postgresql://postgres:***@127.0.0.1:5432/mydb");
    });

    it("should mask password in postgres:// URL", () => {
      const url = "postgres://admin:p4ssw0rd@db.example.com:5432/app";
      const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
      expect(masked).toBe("postgres://admin:***@db.example.com:5432/app");
    });
  });
});

describe("PostgreSQLConnector - connection string pass-through", () => {
  it("should throw if no URL is provided", async () => {
    const connector = new PostgreSQLConnector();
    const noUrlConfig: EngineConfig = { type: "postgres" };

    await expect(
      connector.listDatabases("pg-no-url", noUrlConfig)
    ).rejects.toThrow("requires a connection URL");
  });
});