import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUDIT_DIR = path.join(os.homedir(), ".ai-dba");
const AUDIT_LOG = path.join(AUDIT_DIR, "audit.log");

export interface AuditEntry {
  timestamp: string;
  action: string;
  engineId: string;
  pid: string;
  user?: string;
  database?: string;
  duration?: string;
  query?: string;
  command?: string;
  success: boolean;
  killedAt?: string;
  error?: string;
  notes?: string;
}

/**
 * Append an audit entry to ~/.ai-dba/audit.log (JSONL format).
 * Only called for actual executions (dryRun=false), never for proposals.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  try {
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
    }
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  } catch (err) {
    console.error(`[audit] Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Truncate query text for audit log / display */
export function truncate(text: string | null | undefined, maxLen: number): string | undefined {
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}