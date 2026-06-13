import { describe, it, expect, vi, beforeEach } from "vitest";
import { MySQLConnector } from "./mysql.js";
import type { EngineConfig } from "../config.js";

describe("MySQLConnector", () => {
  let connector: MySQLConnector;
  const mockConfig: EngineConfig = {
    type: "mysql",
    host: "localhost",
    port: 3306,
    user: "root",
    password: "testpassword",
    database: "testdb",
  };

  beforeEach(() => {
    connector = new MySQLConnector();
    vi.clearAllMocks();
  });

  it("should throw error for non-read-only SQL in query method", async () => {
    const pool = {
      getConnection: vi.fn().mockResolvedValue({
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
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it("should allow read-only SQL in query method", async () => {
    const mockConnection = {
      query: vi.fn().mockResolvedValue([
        [{ id: 1, name: "test" }], // rows
        [{ name: "id" }, { name: "name" }], // fields
      ]),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn().mockResolvedValue(mockConnection),
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

    // Ensure the mock connection's query was called
    expect(mockConnection.query).toHaveBeenCalled();
  });
});