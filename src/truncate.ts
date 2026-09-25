/**
 * Sprint 10 Part 2a — row cap + honest truncation helpers (Task 1.2).
 *
 * Every connector's query() passes its rows through applyRowCap() so results
 * always carry an honest truncation signal: `truncated` is true ONLY when rows
 * were actually dropped, and `rowCap` reports the cap that applied whenever
 * truncation was flagged.
 *
 * Server-side limiting (fetch cap + 1 rows) is used only when the rewrite is
 * provably safe: a single statement, no semicolons, a bare SELECT/WITH, no
 * construct whose meaning a trailing LIMIT/TOP/FETCH clause would change, and
 * no data-modifying keyword (WITH ... DELETE/UPDATE/INSERT forms). On ANY
 * doubt each helper returns null and the connector runs the statement as
 * written, slicing client-side with the same honest flag. A rewrite must never
 * turn a working query into a failing one.
 */

export interface CappedRows<T> {
  rows: T[];
  truncated: boolean;
  rowCap: number;
}

/**
 * Slice `rows` to `cap` and report whether anything was dropped.
 * Server-side paths pass cap + 1 rows (the extra row proves truncation);
 * client-side paths pass the full result. Both get identical honesty.
 */
export function applyRowCap<T>(rows: T[], cap: number): CappedRows<T> {
  const truncated = rows.length > cap;
  return { rows: truncated ? rows.slice(0, cap) : rows, truncated, rowCap: cap };
}

/** True for a single SELECT/WITH statement with no semicolon anywhere. */
function isBareSelect(sql: string): boolean {
  if (sql.includes(";")) return false;
  return /^\s*(select|with)\b/i.test(sql);
}

// Data-modifying statements can reach these helpers through WITH ... DELETE /
// UPDATE / INSERT forms. A trailing LIMIT/TOP/FETCH must never be appended to
// those, so any data-modifying keyword forces the client-side fallback. Word
// boundaries keep identifier parts (user_created, last_update) from matching;
// a keyword inside a literal is a false fallback, which is always safe.
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke)\b/i;

// MySQL / PostgreSQL hazards — appending a trailing LIMIT is invalid or
// changes meaning: SELECT ... INTO (write path), an existing LIMIT, standard
// pagination (FETCH FIRST / OFFSET must stay last), and locking clauses that
// must stay last (FOR UPDATE / FOR NO KEY UPDATE / FOR KEY SHARE / FOR SHARE /
// LOCK IN SHARE MODE).
const MYSQL_PG_HAZARD =
  /\b(?:limit|into|fetch|offset|for\s+(?:(?:no\s+)?key\s+)?(?:update|share)|lock\s+in\s+share\s+mode)\b/i;

/**
 * MySQL / PostgreSQL: append "LIMIT n" when provably safe, else null.
 * The clause is separated by a newline so a trailing "--" line comment cannot
 * swallow it (and a stray unterminated block comment can at worst make the
 * clause inert — the client-side slice keeps the result honest either way).
 */
export function rewriteWithLimit(sql: string, n: number): string | null {
  if (!isBareSelect(sql)) return null;
  if (WRITE_KEYWORDS.test(sql)) return null;
  if (MYSQL_PG_HAZARD.test(sql)) return null;
  return `${sql.trim()}\nLIMIT ${n}`;
}

/**
 * SQL Server: insert TOP (n) directly after SELECT / SELECT DISTINCT.
 * Only the plain forms are rewritten; SELECT ALL (a different grammar slot),
 * WITH, an existing TOP, SELECT INTO, FOR XML/JSON/BROWSE/UPDATE, OFFSET/FETCH
 * and semicolon-joined text fall back to a client-side slice.
 */
export function rewriteWithTop(sql: string, n: number): string | null {
  const t = sql.trim();
  if (!t || t.includes(";")) return null;
  if (WRITE_KEYWORDS.test(t)) return null;
  const match = /^select\s+(distinct\s+)?/i.exec(t);
  if (!match) return null;
  if (/^select\s+all\b/i.test(t)) return null;
  if (/\btop\b/i.test(t) || /\binto\b/i.test(t)) return null;
  if (/\bfor\s+(?:xml|json|browse|update)\b/i.test(t)) return null;
  if (/\boffset\b/i.test(t) || /\bfetch\b/i.test(t)) return null;
  return `SELECT ${match[1] ? "DISTINCT " : ""}TOP (${n}) ${t.slice(match[0].length)}`;
}

// Oracle constructs where appending FETCH FIRST is invalid or changes meaning:
// an existing FETCH/ROWNUM, SELECT ... INTO, or a locking clause that must
// stay last (FOR UPDATE).
const ORACLE_HAZARD = /\b(?:fetch|rownum|into|for\s+update)\b/i;

/**
 * Oracle (12c+; container is XE 21): append "FETCH FIRST n ROWS ONLY" when
 * provably safe, else null. The connector additionally passes maxRows = n to
 * the driver — node-oracledb's default maxRows (100) would otherwise cap
 * results silently below the configured rowLimit. Newline-separated for the
 * same comment-safety reason as rewriteWithLimit.
 */
export function rewriteWithFetchFirst(sql: string, n: number): string | null {
  if (!isBareSelect(sql)) return null;
  if (WRITE_KEYWORDS.test(sql)) return null;
  if (ORACLE_HAZARD.test(sql)) return null;
  return `${sql.trim()}\nFETCH FIRST ${n} ROWS ONLY`;
}
