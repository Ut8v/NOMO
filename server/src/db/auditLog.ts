import type { ToolTier } from "../tools/registry.js";
import { getDb } from "./index.js";

export interface AuditEntry {
  toolName: string;
  tier: ToolTier | "unknown";
  params: unknown;
  outcome: string;
}

/** Every tool call is recorded, per the project security rules. */
export function recordToolCall(entry: AuditEntry): void {
  try {
    getDb()
      .prepare("INSERT INTO audit_log (tool_name, tier, params, outcome) VALUES (?, ?, ?, ?)")
      .run(entry.toolName, entry.tier, JSON.stringify(entry.params ?? null), entry.outcome);
  } catch (err) {
    // Auditing must never take down a chat turn, but a silent gap in the
    // log would be worse than noise, so failures are loud in the log.
    console.error("Failed to write audit log entry:", err);
  }
}
