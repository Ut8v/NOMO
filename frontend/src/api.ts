import type {
  ConversationDetail,
  ConversationSummary,
  MemoryView,
  PendingOrderView,
  SetupStatus,
  SaveKeysRequest,
  SaveKeysResponse,
  StoredMessage,
  TablePage,
  TableSummary,
  UsageTotals,
} from "@nomo/shared";

export interface RobinhoodStatus {
  /** Tokens are stored for the real Robinhood MCP. */
  linked: boolean;
  /** Tools are registered and callable right now. */
  active: boolean;
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

export async function fetchRobinhoodAccount(): Promise<{ accountNumber: string | null }> {
  const res = await fetch("/api/robinhood/account");
  if (!res.ok) throw new Error(`Failed to load account (${res.status})`);
  return res.json();
}

export async function saveRobinhoodAccount(accountNumber: string): Promise<{ accountNumber: string }> {
  const res = await fetch("/api/robinhood/account", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountNumber }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to save account (${res.status})`);
  }
  return res.json();
}

export async function listRobinhoodAccounts(): Promise<{ accounts: unknown }> {
  const res = await fetch("/api/robinhood/accounts");
  if (!res.ok) throw new Error(`Failed to load accounts (${res.status})`);
  return res.json();
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

export async function confirmOrder(id: string): Promise<{ order: PendingOrderView }> {
  return orderAction(id, "confirm");
}

export async function rejectOrder(id: string, reason?: string): Promise<{ order: PendingOrderView }> {
  return orderAction(id, "reject", reason ? { reason } : undefined);
}

async function orderAction(
  id: string,
  action: "confirm" | "reject",
  payload?: Record<string, unknown>,
): Promise<{ order: PendingOrderView }> {
  const res = await fetch(`/api/orders/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = (await res.json().catch(() => null)) as { order?: PendingOrderView; error?: string } | null;
  // Conflict responses still carry the order's current state, e.g. expired,
  // so the card can render the truth instead of a bare error.
  if (body?.order && (res.ok || res.status === 409)) {
    return { order: body.order };
  }
  throw new Error(body?.error ?? `The ${action} request failed (${res.status}).`);
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

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`);
  return (await res.json()).conversations as ConversationSummary[];
}

export async function createConversation(title: string): Promise<ConversationSummary> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to create conversation (${res.status})`);
  return (await res.json()).conversation as ConversationSummary;
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load conversation (${res.status})`);
  return (await res.json()).conversation as ConversationDetail;
}

export async function saveConversationMessages(id: string, messages: StoredMessage[]): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`Failed to save conversation (${res.status})`);
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete conversation (${res.status})`);
}

export async function listMemories(): Promise<MemoryView[]> {
  const res = await fetch("/api/memories");
  if (!res.ok) throw new Error(`Failed to load memories (${res.status})`);
  return (await res.json()).memories as MemoryView[];
}

export async function updateMemory(
  id: string,
  patch: { content?: string; status?: "approved" | "pending"; active?: boolean },
): Promise<MemoryView> {
  const res = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to update memory (${res.status})`);
  return (await res.json()).memory as MemoryView;
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete memory (${res.status})`);
}

export async function distillLessons(): Promise<{ created: number; note: string }> {
  const res = await fetch("/api/memories/distill", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Distillation failed (${res.status})`);
  return body;
}

export async function fetchUsageTotals(): Promise<UsageTotals> {
  const res = await fetch("/api/usage");
  if (!res.ok) throw new Error(`Failed to load usage (${res.status})`);
  return res.json();
}

export async function fetchDbTables(): Promise<TableSummary[]> {
  const res = await fetch("/api/admin/tables");
  if (!res.ok) throw new Error(`Failed to load tables (${res.status})`);
  return res.json();
}

export async function fetchDbTable(name: string, limit: number, offset: number): Promise<TablePage> {
  const res = await fetch(`/api/admin/tables/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`Failed to load table ${name} (${res.status})`);
  return res.json();
}
