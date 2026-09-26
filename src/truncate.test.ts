import { describe, it, expect } from "vitest";
import {
  applyRowCap,
  rewriteWithLimit,
  rewriteWithTop,
  rewriteWithFetchFirst,
} from "./truncate.js";

describe("applyRowCap", () => {
  it("passes rows through untouched when under the cap", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const res = applyRowCap(rows, 5);
    expect(res.rows).toEqual(rows);
    expect(res.truncated).toBe(false);
    expect(res.rowCap).toBe(5);
  });

  it("does not flag truncation when the row count exactly equals the cap", () => {
    const res = applyRowCap([1, 2, 3], 3);
    expect(res.rows).toEqual([1, 2, 3]);
    expect(res.truncated).toBe(false);
  });

  it("slices to the cap and flags truncation when one extra row proves it", () => {
    const res = applyRowCap([1, 2, 3], 2);
    expect(res.rows).toEqual([1, 2]);
    expect(res.truncated).toBe(true);
    expect(res.rowCap).toBe(2);
  });

  it("works at cap = 1 (the cap + 1 fetch pattern)", () => {
    expect(applyRowCap([10, 11], 1)).toEqual({ rows: [10], truncated: true, rowCap: 1 });
    expect(applyRowCap([10], 1)).toEqual({ rows: [10], truncated: false, rowCap: 1 });
  });

  it("handles empty results", () => {
    expect(applyRowCap([], 1000)).toEqual({ rows: [], truncated: false, rowCap: 1000 });
  });
});

describe("rewriteWithLimit (MySQL / PostgreSQL)", () => {
  it("appends LIMIT on a new line for a bare SELECT", () => {
    expect(rewriteWithLimit("SELECT * FROM t", 5)).toBe("SELECT * FROM t\nLIMIT 5");
  });

  it("appends LIMIT for a WITH ... SELECT", () => {
    expect(rewriteWithLimit("WITH x AS (SELECT 1) SELECT * FROM x", 5)).toBe(
      "WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 5"
    );
  });

  it("still rewrites compound set operations — a trailing LIMIT binds the whole result (unlike SQL Server TOP)", () => {
    expect(rewriteWithLimit("SELECT a FROM t1 UNION SELECT a FROM t2", 5)).toBe(
      "SELECT a FROM t1 UNION SELECT a FROM t2\nLIMIT 5"
    );
  });

  it("trims trailing whitespace before appending", () => {
    expect(rewriteWithLimit("SELECT * FROM t\n\n  ", 5)).toBe("SELECT * FROM t\nLIMIT 5");
  });

  it("returns null when any semicolon is present", () => {
    expect(rewriteWithLimit("SELECT * FROM t;", 5)).toBeNull();
    expect(rewriteWithLimit("SELECT 1; SELECT 2", 5)).toBeNull();
  });

  it("returns null when a LIMIT already exists (case-insensitive)", () => {
    expect(rewriteWithLimit("SELECT * FROM t LIMIT 10", 5)).toBeNull();
    expect(rewriteWithLimit("select * from t limit 10", 5)).toBeNull();
  });

  it("returns null for standard pagination clauses (FETCH / OFFSET)", () => {
    expect(rewriteWithLimit("SELECT * FROM t FETCH FIRST 10 ROWS ONLY", 5)).toBeNull();
    expect(rewriteWithLimit("SELECT * FROM t OFFSET 10 ROWS", 5)).toBeNull();
  });

  it("returns null for locking clauses", () => {
    expect(rewriteWithLimit("SELECT * FROM t FOR UPDATE", 5)).toBeNull();
    expect(rewriteWithLimit("SELECT * FROM t FOR NO KEY UPDATE", 5)).toBeNull();
    expect(rewriteWithLimit("SELECT * FROM t FOR KEY SHARE", 5)).toBeNull();
    expect(rewriteWithLimit("SELECT * FROM t FOR SHARE", 5)).toBeNull();
    expect(rewriteWithLimit("SELECT * FROM t LOCK IN SHARE MODE", 5)).toBeNull();
  });

  it("returns null for SELECT ... INTO (write path)", () => {
    expect(rewriteWithLimit("SELECT * INTO OUTFILE '/tmp/x' FROM t", 5)).toBeNull();
  });

  it("is conservative about hazard words inside string literals", () => {
    expect(rewriteWithLimit("SELECT 'no limit here' AS note FROM t", 5)).toBeNull();
  });

  it("returns null for non-SELECT statements (SHOW / DESCRIBE / EXPLAIN)", () => {
    expect(rewriteWithLimit("SHOW TABLES", 5)).toBeNull();
    expect(rewriteWithLimit("DESCRIBE t", 5)).toBeNull();
    expect(rewriteWithLimit("EXPLAIN SELECT * FROM t", 5)).toBeNull();
  });

  it("returns null for data-modifying WITH forms (defense in depth)", () => {
    expect(rewriteWithLimit("WITH x AS (SELECT 1 AS id) DELETE FROM t WHERE id IN (SELECT id FROM x)", 5)).toBeNull();
    expect(rewriteWithLimit("WITH x AS (SELECT 1 AS id) INSERT INTO t2 SELECT * FROM x", 5)).toBeNull();
    expect(rewriteWithLimit("WITH x AS (SELECT 1 AS id) UPDATE t SET id = 2 WHERE id IN (SELECT id FROM x)", 5)).toBeNull();
  });
});

describe("rewriteWithTop (SQL Server)", () => {
  it("inserts TOP after SELECT", () => {
    expect(rewriteWithTop("SELECT id FROM t", 5)).toBe("SELECT TOP (5) id FROM t");
  });

  it("inserts TOP after SELECT DISTINCT", () => {
    expect(rewriteWithTop("SELECT DISTINCT id FROM t", 5)).toBe("SELECT DISTINCT TOP (5) id FROM t");
  });

  it("handles leading whitespace and newlines", () => {
    expect(rewriteWithTop("  select\n  id from t", 5)).toBe("SELECT TOP (5) id from t");
  });

  it("returns null when a TOP already exists", () => {
    expect(rewriteWithTop("SELECT TOP (10) id FROM t", 5)).toBeNull();
  });

  it("returns null for SELECT ALL (grammar slot is not worth rewriting)", () => {
    expect(rewriteWithTop("SELECT ALL id FROM t", 5)).toBeNull();
  });

  it("returns null for INTO, FOR XML/JSON/BROWSE/UPDATE", () => {
    expect(rewriteWithTop("SELECT id INTO #tmp FROM t", 5)).toBeNull();
    expect(rewriteWithTop("SELECT id FROM t FOR XML PATH('')", 5)).toBeNull();
    expect(rewriteWithTop("SELECT id FROM t FOR JSON AUTO", 5)).toBeNull();
    expect(rewriteWithTop("SELECT id FROM t FOR BROWSE", 5)).toBeNull();
    expect(rewriteWithTop("SELECT id FROM t FOR UPDATE", 5)).toBeNull();
  });

  it("returns null for OFFSET/FETCH pagination and WITH (CTE)", () => {
    expect(rewriteWithTop("SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY", 5)).toBeNull();
    expect(rewriteWithTop("WITH x AS (SELECT 1 AS id) SELECT id FROM x", 5)).toBeNull();
  });

  it("returns null for semicolons and non-SELECT statements", () => {
    expect(rewriteWithTop("SELECT id FROM t;", 5)).toBeNull();
    expect(rewriteWithTop("EXPLAIN SELECT 1", 5)).toBeNull();
    expect(rewriteWithTop("DESCRIBE t", 5)).toBeNull();
  });

  it("returns null for compound set operations (TOP would bind only the first arm)", () => {
    expect(rewriteWithTop("SELECT a FROM t1 UNION SELECT a FROM t2", 5)).toBeNull();
    expect(rewriteWithTop("select a from t1 union all select a from t2", 5)).toBeNull();
    expect(rewriteWithTop("SELECT a FROM t1 EXCEPT SELECT a FROM t2", 5)).toBeNull();
    expect(rewriteWithTop("SELECT a FROM t1 INTERSECT SELECT a FROM t2", 5)).toBeNull();
  });

  it("returns null when destructive keywords appear (defense in depth)", () => {
    expect(rewriteWithTop("SELECT id FROM t WHERE name = 'delete me'", 5)).toBeNull();
  });
});

describe("rewriteWithFetchFirst (Oracle)", () => {
  it("appends FETCH FIRST on a new line for a bare SELECT", () => {
    expect(rewriteWithFetchFirst("SELECT id FROM t", 5)).toBe("SELECT id FROM t\nFETCH FIRST 5 ROWS ONLY");
  });

  it("appends FETCH FIRST for a WITH ... SELECT", () => {
    expect(rewriteWithFetchFirst("WITH x AS (SELECT 1 FROM dual) SELECT * FROM x", 5)).toBe(
      "WITH x AS (SELECT 1 FROM dual) SELECT * FROM x\nFETCH FIRST 5 ROWS ONLY"
    );
  });

  it("still rewrites compound set operations — a trailing FETCH binds the whole result", () => {
    expect(rewriteWithFetchFirst("SELECT a FROM t1 UNION SELECT a FROM t2", 5)).toBe(
      "SELECT a FROM t1 UNION SELECT a FROM t2\nFETCH FIRST 5 ROWS ONLY"
    );
  });

  it("returns null when FETCH or ROWNUM already exists", () => {
    expect(rewriteWithFetchFirst("SELECT id FROM t FETCH FIRST 10 ROWS ONLY", 5)).toBeNull();
    expect(rewriteWithFetchFirst("SELECT id FROM t WHERE ROWNUM <= 10", 5)).toBeNull();
  });

  it("returns null for INTO and FOR UPDATE", () => {
    expect(rewriteWithFetchFirst("SELECT id INTO v_id FROM t", 5)).toBeNull();
    expect(rewriteWithFetchFirst("SELECT id FROM t FOR UPDATE", 5)).toBeNull();
  });

  it("returns null for semicolons and non-SELECT statements", () => {
    expect(rewriteWithFetchFirst("SELECT id FROM t;", 5)).toBeNull();
    expect(rewriteWithFetchFirst("DESCRIBE t", 5)).toBeNull();
  });

  it("returns null for data-modifying WITH forms (defense in depth)", () => {
    expect(rewriteWithFetchFirst("WITH x AS (SELECT 1 FROM dual) DELETE FROM t WHERE 1 = 1", 5)).toBeNull();
  });
});
