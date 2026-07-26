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

/** A tool call starting or finishing during a turn, for the live activity view. */
export interface ToolEvent {
  id: string;
  name: string;
  tier: string;
  phase: "start" | "end";
  /** Present on the end phase. */
  ok?: boolean;
  /** Sub-agent lane this call belongs to during orchestrated research. */
  agent?: string;
}

/** A research sub-agent lane starting or finishing during orchestrated work. */
export interface AgentEvent {
  /** Lane id, e.g. technicals, fundamentals, synthesis, skeptic. */
  name: string;
  phase: "start" | "end";
  /** Present on the end phase: whether the agent produced a usable result. */
  ok?: boolean;
}

/** Events sent over the SSE chat stream, one JSON object per data line. */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "chart"; spec: ChartSpec }
  | { type: "pending_order"; order: PendingOrderView }
  | { type: "tool"; event: ToolEvent }
  | { type: "agent"; event: AgentEvent }
  | { type: "usage"; usage: UsageEvent }
  | { type: "done" }
  | { type: "error"; code: ChatErrorCode; message: string };
