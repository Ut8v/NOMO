import type { SetupStatus, SaveKeysRequest, SaveKeysResponse } from "@nomo/shared";

export interface RobinhoodStatus {
  linked: boolean;
  tools: string[];
}

export interface TierSetting {
  tier: string;
  enabled: boolean;
  tools: string[];
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch("/api/setup/status");
  if (!res.ok) {
    throw new Error(`Failed to load setup status (${res.status})`);
  }
  return res.json();
}

export async function fetchRobinhoodStatus(): Promise<RobinhoodStatus> {
  const res = await fetch("/api/robinhood/status");
  if (!res.ok) throw new Error(`Failed to load Robinhood status (${res.status})`);
  return res.json();
}

export async function startRobinhoodLink(): Promise<{ authorizeUrl: string; linked: boolean }> {
  const res = await fetch("/api/robinhood/link", { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Failed to start link (${res.status})`);
  return body;
}

export async function unlinkRobinhood(): Promise<void> {
  const res = await fetch("/api/robinhood/unlink", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to unlink (${res.status})`);
}

export async function fetchTierSettings(): Promise<TierSetting[]> {
  const res = await fetch("/api/settings/tools");
  if (!res.ok) throw new Error(`Failed to load tool settings (${res.status})`);
  return res.json();
}

export async function updateTierSetting(tier: string, enabled: boolean): Promise<void> {
  const res = await fetch("/api/settings/tools", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier, enabled }),
  });
  if (!res.ok) throw new Error(`Failed to update tool settings (${res.status})`);
}

export async function saveKeys(request: SaveKeysRequest): Promise<SaveKeysResponse> {
  const res = await fetch("/api/setup/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  // 422 carries per-key validation results, so parse it like a success.
  if (!res.ok && res.status !== 422) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to save keys (${res.status})`);
  }
  return res.json();
}
