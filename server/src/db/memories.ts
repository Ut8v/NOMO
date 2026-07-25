import { randomUUID } from "node:crypto";
import type { MemorySource, MemoryStatus, MemoryView } from "@nomo/shared";
import { getDb } from "./index.js";

/**
 * Trader profile memory storage. Memories are read-only background about the
 * user, injected into the system prompt to shape proposals. Nothing here is
 * ever read by the confirmation gate or any execution path.
 */

// Hard cap on how many memories stay active. Beyond it, the oldest are
// deactivated (evicted) rather than deleted, so the user can still see them.
const MAX_ACTIVE_MEMORIES = 100;

// Rough character budget for injected memories. A conservative stand-in for a
// small token budget (about 4 characters per token).
const INJECTION_CHAR_BUDGET = 1600;

interface MemoryRow {
  id: string;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  active: number;
  created_at: string;
  updated_at: string;
}

function toView(row: MemoryRow): MemoryView {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    status: row.status,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewMemory {
  content: string;
  source: MemorySource;
  status: MemoryStatus;
}

export function createMemory(memory: NewMemory): MemoryView {
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO memories (id, content, source, status) VALUES (?, ?, ?, ?)")
    .run(id, memory.content, memory.source, memory.status);
  evictBeyondCap();
  return getMemory(id)!;
}

export function getMemory(id: string): MemoryView | null {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  return row ? toView(row) : null;
}

export function listMemories(): MemoryView[] {
  const rows = getDb().prepare("SELECT * FROM memories ORDER BY created_at DESC, rowid DESC").all() as MemoryRow[];
  return rows.map(toView);
}

export function updateMemory(id: string, patch: { content?: string; status?: MemoryStatus; active?: boolean }): MemoryView | null {
  const existing = getMemory(id);
  if (!existing) return null;
  getDb()
    .prepare(
      `UPDATE memories
       SET content = ?, status = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(
      patch.content ?? existing.content,
      patch.status ?? existing.status,
      patch.active === undefined ? (existing.active ? 1 : 0) : patch.active ? 1 : 0,
      id,
    );
  return getMemory(id);
}

export function deleteMemory(id: string): boolean {
  return getDb().prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

/**
 * The only memories that reach the prompt: approved and active, newest first,
 * trimmed to the character budget. Returned in chronological order so the
 * prompt reads oldest to newest.
 */
export function listInjectableMemories(): string[] {
  const rows = getDb()
    .prepare("SELECT content FROM memories WHERE active = 1 AND status = 'approved' ORDER BY created_at DESC, rowid DESC")
    .all() as { content: string }[];

  const selected: string[] = [];
  let used = 0;
  for (const row of rows) {
    const cost = row.content.length + 2;
    if (used + cost > INJECTION_CHAR_BUDGET) break;
    selected.push(row.content);
    used += cost;
  }
  return selected.reverse();
}

/** Deactivates the oldest active memories beyond the cap; never deletes. */
function evictBeyondCap(): void {
  getDb()
    .prepare(
      `UPDATE memories SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id IN (
         SELECT id FROM memories WHERE active = 1
         ORDER BY created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .run(MAX_ACTIVE_MEMORIES);
}
