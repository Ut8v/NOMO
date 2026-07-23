// Type-only import; registry imports this module at runtime, so a value
// import here would create a cycle.
import type { ToolTier } from "../tools/registry.js";
import { getDb } from "./index.js";

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(key, value);
}

/** Tiers default to enabled; only an explicit "false" disables one. */
export function isTierEnabled(tier: ToolTier): boolean {
  return getSetting(`tier_enabled:${tier}`) !== "false";
}

export function setTierEnabled(tier: ToolTier, enabled: boolean): void {
  setSetting(`tier_enabled:${tier}`, enabled ? "true" : "false");
}
