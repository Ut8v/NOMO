/**
 * Persisted conversation types. Message blocks are stored as opaque JSON so
 * text, charts, and order cards all round-trip; the frontend owns the block
 * shape (see MessageBlock in the chat UI).
 */

export interface StoredMessage {
  role: "user" | "assistant";
  blocks: unknown[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  createdAt: string;
  messages: StoredMessage[];
}
