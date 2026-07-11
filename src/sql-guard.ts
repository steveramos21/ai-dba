/**
 * Shared SQL validation guard — used by CLI, REPL, and MCP tool paths.
 * Prevents destructive SQL from reaching connectors via explain or query commands.
 */

/**
 * Validate that a SQL string is read-only (SELECT, WITH only).
 * Strips trailing semicolons, rejects multiple statements, scans for destructive keywords.
 */
export function validateReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("Empty query — provide a SELECT or WITH statement.");
  }
  // Reject multiple statements (semicolon not at end)
  if (trimmed.includes(";") && !trimmed.endsWith(";")) {
    throw new Error("Multiple statements are not allowed. Provide a single SELECT or WITH query.");
  }
  const sqlUpper = trimmed.replace(/;$/, "").trim().toUpperCase();
  const readOnlyPrefixes = ["SELECT", "WITH", "EXPLAIN", "DESCRIBE", "DESC", "SHOW"];
  if (!readOnlyPrefixes.some((p) => sqlUpper.startsWith(p))) {
    throw new Error(`Only read-only queries (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE) are allowed. Got: ${sqlUpper.substring(0, 50)}`);
  }
  const destructive = ["INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE", "MERGE", "GRANT", "REVOKE"];
  for (const kw of destructive) {
    if (new RegExp(`\\b${kw}\\b`).test(sqlUpper)) {
      throw new Error(`Destructive keyword "${kw}" is not allowed in read-only queries.`);
    }
  }
}

/**
 * Stricter validation for EXPLAIN queries — only SELECT and WITH are allowed.
 * SHOW/EXPLAIN/DESCRIBE prefixes would cause double-EXPLAIN syntax errors.
 * When analyze=true, the query is actually executed, so this is a safety-critical path.
 */
export function validateExplainQuery(sql: string, analyze: boolean): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("Empty query — provide a SELECT or WITH statement to explain.");
  }
  if (trimmed.includes(";") && !trimmed.endsWith(";")) {
    throw new Error("Multiple statements are not allowed. Provide a single SELECT or WITH query.");
  }
  const sqlUpper = trimmed.replace(/;$/, "").trim().toUpperCase();
  if (!sqlUpper.startsWith("SELECT") && !sqlUpper.startsWith("WITH")) {
    throw new Error(`Explain only supports SELECT or WITH queries. Got: ${sqlUpper.substring(0, 50)}`);
  }
  // When analyze=true (PostgreSQL EXPLAIN ANALYZE), the query is actually executed.
  // Extra guard against destructive keywords.
  const destructive = ["INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE", "MERGE", "GRANT", "REVOKE"];
  for (const kw of destructive) {
    if (new RegExp(`\\b${kw}\\b`).test(sqlUpper)) {
      throw new Error(`Destructive keyword "${kw}" is not allowed in explain queries.`);
    }
  }
}

/**
 * Check if a string is a JSON command document (for MongoDB).
 * Returns true if the string starts with { — MongoDB explain takes JSON, not SQL.
 */
export function isJsonCommand(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.startsWith("{");
}