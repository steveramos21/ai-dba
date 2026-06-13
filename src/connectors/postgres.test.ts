import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostgreSQLConnector } from "./postgres.js";
import type { EngineConfig } from "../config.js";

describe("PostgreSQLConnector", () => {
  let connector: PostgreSQLConnector;
  const mockConfig: EngineConfig = { type: "postgres", url: "postgresql://postgres@localhost:5432/testdb" };

  beforeEach(() => {
    connector = new PostgreSQLConnector();
    vi.clearAllMocks();
  });

  it("should list databases", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ name: "testdb", charset: "UTF8" }] }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    const result = await connector.listDatabases("test-engine", mockConfig);
    expect(result).toEqual([{ name: "testdb", charset: "UTF8" }]);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_database")
    );
  });

  it("should throw error for non-read-only SQL in query method", async () => {
    const pool = {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(),
        release: vi.fn(),
      }),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    await expect(
      connector.query("test-engine", mockConfig, "DROP TABLE test")
    ).rejects.toThrow("Only read-only queries");

    // Ensure that we never attempted to get a connection from the pool
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("should allow read-only SQL in query method", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "test" }],
        rowCount: 1,
        fields: [{ name: "id", dataTypeID: 23 }, { name: "name", dataTypeID: 25 }],
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    };
    // @ts-expect-error - we're mocking the private pool
    connector.pools.set("test-engine", pool);

    // Test SELECT
    await expect(
      connector.query("test-engine", mockConfig, "SELECT * FROM test")
    ).resolves.toEqual({
      columns: ["id", "name"],
      rows: [{ id: 1, name: "test" }],
    });

    // Ensure the mock client's query was called
    expect(mockClient.query).toHaveBeenCalled();
  });
});