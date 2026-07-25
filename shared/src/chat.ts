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

import type { ChartSpec } from "./chart.js";
import type { PendingOrderView } from "./orders.js";
import type { UsageTotals } from "./usage.js";

/** Anthropic token usage for one assistant turn plus the running total. */
export interface UsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost of this turn, USD. */
  costUsd: number;
  /** Running totals across all turns, USD and tokens. */
  total: UsageTotals;
}

/** Events sent over the SSE chat stream, one JSON object per data line. */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "chart"; spec: ChartSpec }
  | { type: "pending_order"; order: PendingOrderView }
  | { type: "usage"; usage: UsageEvent }
  | { type: "done" }
  | { type: "error"; code: ChatErrorCode; message: string };
