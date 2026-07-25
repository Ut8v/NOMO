import { randomUUID } from "node:crypto";
import type { ConversationDetail, ConversationSummary, StoredMessage } from "@nomo/shared";
import { getDb } from "./index.js";
import { indexConversation, removeConversationFromIndex } from "./search.js";

const MAX_TITLE_LENGTH = 80;

function deriveTitle(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New conversation";
  return trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…` : trimmed;
}

export function createConversation(title: string): ConversationSummary {
  const id = randomUUID();
  getDb().prepare("INSERT INTO conversations (id, title) VALUES (?, ?)").run(id, deriveTitle(title));
  return getConversationSummary(id)!;
}

export function getConversationSummary(id: string): ConversationSummary | null {
  const row = getDb()
    .prepare("SELECT id, title, updated_at FROM conversations WHERE id = ?")
    .get(id) as { id: string; title: string; updated_at: string } | undefined;
  return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : null;
}

export function listConversations(): ConversationSummary[] {
  const rows = getDb()
    .prepare("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC")
    .all() as { id: string; title: string; updated_at: string }[];
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
}

export function getConversation(id: string): ConversationDetail | null {
  const summary = getDb()
    .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?")
    .get(id) as { id: string; title: string; created_at: string; updated_at: string } | undefined;
  if (!summary) return null;

  const rows = getDb()
    .prepare("SELECT role, blocks FROM messages WHERE conversation_id = ? ORDER BY seq")
    .all(id) as { role: "user" | "assistant"; blocks: string }[];

  const messages: StoredMessage[] = rows.map((row) => ({
    role: row.role,
    blocks: JSON.parse(row.blocks) as unknown[],
  }));

  return { id: summary.id, title: summary.title, createdAt: summary.created_at, updatedAt: summary.updated_at, messages };
}

/** Replaces all messages for a conversation in one transaction. */
export function replaceMessages(id: string, messages: StoredMessage[]): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id);
  if (!exists) return false;

  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    const insert = db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, blocks) VALUES (?, ?, ?, ?)",
    );
    messages.forEach((message, seq) => {
      insert.run(id, seq, message.role, JSON.stringify(message.blocks));
    });
    db.prepare(
      "UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(id);
    indexConversation(id, messages);
  })();
  return true;
}

export function deleteConversation(id: string): boolean {
  const removed = getDb().prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
  if (removed) removeConversationFromIndex(id);
  return removed;
}
