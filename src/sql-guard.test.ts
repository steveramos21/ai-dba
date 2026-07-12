import { describe, it, expect } from "vitest";
import { validateReadOnlySql, validateExplainQuery, isJsonCommand } from "./sql-guard.js";

describe("validateReadOnlySql", () => {
  it("accepts SELECT queries", () => {
    expect(() => validateReadOnlySql("SELECT * FROM users")).not.toThrow();
    expect(() => validateReadOnlySql("select id, name from users where id = 1")).not.toThrow();
  });

  it("accepts WITH (CTE) queries", () => {
    expect(() => validateReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).not.toThrow();
  });

  it("accepts SHOW queries", () => {
    expect(() => validateReadOnlySql("SHOW DATABASES")).not.toThrow();
  });

  it("accepts EXPLAIN queries", () => {
    expect(() => validateReadOnlySql("EXPLAIN SELECT * FROM users")).not.toThrow();
  });

  it("rejects empty input", () => {
    expect(() => validateReadOnlySql("")).toThrow("Empty query");
    expect(() => validateReadOnlySql("   ")).toThrow("Empty query");
  });

  it("rejects multiple statements", () => {
    expect(() => validateReadOnlySql("SELECT 1; SELECT 2")).toThrow("Multiple statements");
  });

  it("allows trailing semicolon", () => {
    expect(() => validateReadOnlySql("SELECT 1;")).not.toThrow();
  });

  it("rejects destructive keywords", () => {
    expect(() => validateReadOnlySql("INSERT INTO users VALUES (1)")).toThrow("Only read-only");
    expect(() => validateReadOnlySql("DROP TABLE users")).toThrow("Only read-only");
    expect(() => validateReadOnlySql("DELETE FROM users")).toThrow("Only read-only");
    expect(() => validateReadOnlySql("UPDATE users SET name='x'")).toThrow("Only read-only");
    expect(() => validateReadOnlySql("TRUNCATE TABLE users")).toThrow("Only read-only");
    expect(() => validateReadOnlySql("ALTER TABLE users ADD COLUMN x INT")).toThrow("Only read-only");
    expect(() => validateReadOnlySql("CREATE TABLE x (id INT)")).toThrow("Only read-only");
  });

  it("rejects destructive keywords embedded in read-only query", () => {
    expect(() => validateReadOnlySql("SELECT * FROM users WHERE id IN (DELETE FROM x)")).toThrow("Destructive keyword");
  });
});

describe("validateExplainQuery", () => {
  it("accepts SELECT queries", () => {
    expect(() => validateExplainQuery("SELECT * FROM users", false)).not.toThrow();
    expect(() => validateExplainQuery("SELECT * FROM users WHERE id = 1", true)).not.toThrow();
  });

  it("accepts WITH (CTE) queries", () => {
    expect(() => validateExplainQuery("WITH x AS (SELECT 1) SELECT * FROM x", false)).not.toThrow();
  });

  it("rejects SHOW/EXPLAIN/DESCRIBE prefixes (would cause double-EXPLAIN)", () => {
    expect(() => validateExplainQuery("SHOW TABLES", false)).toThrow("only supports SELECT or WITH");
    expect(() => validateExplainQuery("EXPLAIN SELECT 1", false)).toThrow("only supports SELECT or WITH");
    expect(() => validateExplainQuery("DESCRIBE users", false)).toThrow("only supports SELECT or WITH");
  });

  it("rejects empty input", () => {
    expect(() => validateExplainQuery("", false)).toThrow("Empty query");
  });

  it("rejects multiple statements", () => {
    expect(() => validateExplainQuery("SELECT 1; SELECT 2", false)).toThrow("Multiple statements");
  });

  it("rejects destructive keywords even with SELECT prefix", () => {
    expect(() => validateExplainQuery("SELECT * FROM x; DROP TABLE x", false)).toThrow("Multiple statements");
  });

  it("rejects non-SELECT/WITH prefixes", () => {
    expect(() => validateExplainQuery("INSERT INTO x VALUES (1)", false)).toThrow("only supports SELECT or WITH");
    expect(() => validateExplainQuery("UPDATE x SET y=1", false)).toThrow("only supports SELECT or WITH");
  });
});

describe("isJsonCommand", () => {
  it("returns true for JSON objects", () => {
    expect(isJsonCommand('{"find": "users"}')).toBe(true);
    expect(isJsonCommand('  {"filter": {}}')).toBe(true);
  });

  it("returns false for SQL strings", () => {
    expect(isJsonCommand("SELECT * FROM users")).toBe(false);
    expect(isJsonCommand("SHOW DATABASES")).toBe(false);
  });

  it("returns false for empty or whitespace", () => {
    expect(isJsonCommand("")).toBe(false);
    expect(isJsonCommand("   ")).toBe(false);
  });

  it("returns false for JSON arrays", () => {
    expect(isJsonCommand("[1, 2, 3]")).toBe(false);
  });
});