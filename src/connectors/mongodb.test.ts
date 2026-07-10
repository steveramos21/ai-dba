import { describe, it, expect } from "vitest";
import { parseMongoUrl } from "./mongodb.js";

describe("parseMongoUrl", () => {
  it("extracts database from URL", () => {
    const r = parseMongoUrl("mongodb://user:pass@10.0.0.1:27017/mydb");
    expect(r.database).toBe("mydb");
    expect(r.uri).toBe("mongodb://user:pass@10.0.0.1:27017/mydb");
  });

  it("defaults to admin when no database in path", () => {
    const r = parseMongoUrl("mongodb://user:pass@host:27017");
    expect(r.database).toBe("admin");
  });

  it("handles mongodb+srv:// scheme", () => {
    const r = parseMongoUrl("mongodb+srv://user:pass@cluster.example.com/mydb?authSource=admin");
    expect(r.database).toBe("mydb");
  });

  it("throws on invalid URL", () => {
    expect(() => parseMongoUrl("not-a-url")).toThrow("Invalid MongoDB URL");
  });
});