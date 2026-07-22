import type { SetupStatus, SaveKeysRequest, SaveKeysResponse } from "@nomo/shared";

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch("/api/setup/status");
  if (!res.ok) {
    throw new Error(`Failed to load setup status (${res.status})`);
  }
  return res.json();
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
