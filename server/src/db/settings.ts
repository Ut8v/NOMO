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

/**
 * Per-agent toggle for research specialists. Unlike tiers, an agent can default
 * off (the options specialist does), so the default is explicit rather than
 * assumed enabled.
 */
export function isAgentEnabled(agent: string, defaultEnabled: boolean): boolean {
  const value = getSetting(`agent_enabled:${agent}`);
  if (value === null) return defaultEnabled;
  return value !== "false";
}

export function setAgentEnabled(agent: string, enabled: boolean): void {
  setSetting(`agent_enabled:${agent}`, enabled ? "true" : "false");
}

const ACCOUNT_NUMBER_KEY = "robinhood_account_number";

/**
 * The Robinhood account number orders are placed against. It is required by the
 * broker and must be chosen by the user (never guessed by the agent), so it is
 * set from the UI and stored here, not hardcoded anywhere.
 */
export function getRobinhoodAccountNumber(): string | null {
  return getSetting(ACCOUNT_NUMBER_KEY);
}

export function setRobinhoodAccountNumber(accountNumber: string): void {
  setSetting(ACCOUNT_NUMBER_KEY, accountNumber);
}
