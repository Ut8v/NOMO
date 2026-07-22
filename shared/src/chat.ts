/**
 * Types for the chat stream, shared between server and frontend.
 */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
}

/**
 * Upper bound on messages per request, enforced by the server and used by
 * the frontend to window the history it sends.
 */
export const MAX_CHAT_MESSAGES = 200;

export type ChatErrorCode =
  | "missing_api_key"
  | "invalid_api_key"
  | "overloaded"
  | "stream_error";

/** Events sent over the SSE chat stream, one JSON object per data line. */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "done" }
  | { type: "error"; code: ChatErrorCode; message: string };
