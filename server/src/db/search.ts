import type { StoredMessage } from "@nomo/shared";
import { getDb } from "./index.js";

/**
 * Full text search over archived chat messages. The index mirrors the text
 * blocks of every message and is maintained by the conversation write path.
 */

export interface SearchHit {
  conversationId: string;
  title: string;
  snippet: string;
}

/** Extracts the searchable text from a stored message's blocks. */
export function messageText(message: StoredMessage): string {
  return message.blocks
    .filter(
      (block): block is { kind: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { kind?: unknown }).kind === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}

/** Rewrites the index rows for one conversation. Call inside a transaction. */
export function indexConversation(conversationId: string, messages: StoredMessage[]): void {
  const db = getDb();
  db.prepare("DELETE FROM messages_fts WHERE conversation_id = ?").run(conversationId);
  const insert = db.prepare("INSERT INTO messages_fts (text, conversation_id) VALUES (?, ?)");
  for (const message of messages) {
    const text = messageText(message).trim();
    if (text) insert.run(text, conversationId);
  }
}

export function removeConversationFromIndex(conversationId: string): void {
  getDb().prepare("DELETE FROM messages_fts WHERE conversation_id = ?").run(conversationId);
}

/** Builds a safe FTS MATCH expression: quoted tokens joined implicitly (AND). */
function toMatchExpression(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"`);
  return tokens.length > 0 ? tokens.join(" ") : null;
}

export function searchMessages(query: string, limit = 10): SearchHit[] {
  const match = toMatchExpression(query);
  if (!match) return [];
  const rows = getDb()
    .prepare(
      `SELECT c.id AS conversation_id, c.title AS title,
              snippet(messages_fts, 0, '[', ']', '…', 10) AS snippet
       FROM messages_fts
       JOIN conversations c ON c.id = messages_fts.conversation_id
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, limit) as { conversation_id: string; title: string; snippet: string }[];
  return rows.map((row) => ({ conversationId: row.conversation_id, title: row.title, snippet: row.snippet }));
}

/** One-time backfill: if the index is empty but messages exist, rebuild it. */
export function ensureSearchIndex(): void {
  const db = getDb();
  const indexed = (db.prepare("SELECT count(*) AS n FROM messages_fts").get() as { n: number }).n;
  if (indexed > 0) return;
  const messageCount = (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
  if (messageCount === 0) return;

  const rows = db
    .prepare("SELECT conversation_id, blocks FROM messages ORDER BY conversation_id, seq")
    .all() as { conversation_id: string; blocks: string }[];
  const insert = db.prepare("INSERT INTO messages_fts (text, conversation_id) VALUES (?, ?)");
  db.transaction(() => {
    for (const row of rows) {
      const message: StoredMessage = { role: "user", blocks: JSON.parse(row.blocks) as unknown[] };
      const text = messageText(message).trim();
      if (text) insert.run(text, row.conversation_id);
    }
  })();
}
