import Anthropic from "@anthropic-ai/sdk";
import type { ChartSpec, ChatErrorCode, ChatMessage, PendingOrderView } from "@nomo/shared";
import { config } from "../config.js";
import { recordToolCall } from "../db/auditLog.js";
import { getCredential } from "../db/credentials.js";
import { isTierEnabled } from "../db/settings.js";
import { getTool, getToolSchemas } from "../tools/registry.js";

export class ChatError extends Error {
  constructor(
    public readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** Single source for the missing key error so route and service cannot drift. */
export const MISSING_API_KEY = {
  code: "missing_api_key",
  message: "No Anthropic API key is stored. Run setup first.",
} as const;

function buildSystemPrompt(toolCount: number): string {
  const base = [
    "You are the assistant in NOMO, a local, single user trading chat app.",
    "Be direct and concise. Do not fabricate market data or account state;",
    "when you cannot know something, say so.",
  ].join(" ");
  return toolCount > 0
    ? `${base} Use the available tools when they help answer the question. Charts you rendered in earlier turns are visible to the user but omitted from this transcript; call render_chart again whenever a new or updated chart is needed. Placing an order only creates a proposal that the user must explicitly confirm in the app; never state an order executed unless a bracketed system record in the transcript says so. Those bracketed order records are inserted by the app, not written by you.`
    : `${base} No tools are available yet; say so if asked to fetch live data.`;
}

const MAX_TOKENS = 4096;

// Backstop against a tool call loop that never converges. Generous enough
// that legitimate multi step tool use in later phases will not hit it.
const MAX_TOOL_ROUNDS = 10;

interface ToolUseOutcome {
  block: Anthropic.ToolResultBlockParam;
  chart?: ChartSpec;
  pendingOrder?: PendingOrderView;
}

async function executeToolUse(block: Anthropic.ToolUseBlock): Promise<ToolUseOutcome> {
  const errorResult = (content: string): ToolUseOutcome => ({
    block: { type: "tool_result", tool_use_id: block.id, content, is_error: true },
  });

  const tool = getTool(block.name);
  if (!tool) {
    recordToolCall({ toolName: block.name, tier: "unknown", params: block.input, outcome: "rejected: unknown tool" });
    return errorResult(`Unknown tool: ${block.name}`);
  }
  // Disabled tiers are removed from the schema sent to Claude; this guard
  // covers a call arriving anyway, e.g. from a turn started before the
  // toggle changed.
  if (!isTierEnabled(tool.tier)) {
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: "blocked: tier disabled" });
    return errorResult(`The ${tool.tier} tools are currently disabled in settings.`);
  }
  // Execution tier tools registered here are gate proposals only: their
  // execute() writes a pending_orders row and returns. The broker is
  // reachable solely via the confirmation gate (services/executionGate.ts),
  // which requires a stored order in confirmed status.
  try {
    const result = await tool.execute(block.input);
    // A tool returning something unserializable (circular refs, BigInt)
    // must degrade to a tool error, not crash the turn.
    let content: string;
    try {
      content = JSON.stringify(result.forModel) ?? "null";
    } catch {
      recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: "error: unserializable result" });
      return errorResult(`The ${tool.name} tool returned a malformed result.`);
    }
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: result.pendingOrder ? `pending confirmation: ${result.pendingOrder.id}` : "ok" });
    return {
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content,
      },
      chart: result.chart,
      pendingOrder: result.pendingOrder,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed.";
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: `error: ${message}` });
    return errorResult(message);
  }
}

function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) {
    return err;
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401) {
      return new ChatError(
        "invalid_api_key",
        "Anthropic rejected the stored API key. Update it in settings.",
      );
    }
    if (err.status === 429 || err.status === 529) {
      return new ChatError(
        "overloaded",
        "The Anthropic API is rate limited or overloaded right now. Try again shortly.",
      );
    }
    return new ChatError("stream_error", `Anthropic API error (${err.status ?? "network"}).`);
  }
  return new ChatError("stream_error", "The chat stream failed unexpectedly.");
}

export interface ChatTurnHandlers {
  onText: (text: string) => void;
  onChart: (spec: ChartSpec) => void;
  onPendingOrder: (order: PendingOrderView) => void;
}

/**
 * Runs one assistant turn: streams text and chart specs to the handlers and
 * resolves tool calls in a loop until the model stops.
 */
export async function streamChatTurn(
  messages: ChatMessage[],
  handlers: ChatTurnHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const apiKey = getCredential("anthropic");
  if (!apiKey) {
    throw new ChatError(MISSING_API_KEY.code, MISSING_API_KEY.message);
  }

  const client = new Anthropic({ apiKey });
  const tools = getToolSchemas();
  const systemPrompt = buildSystemPrompt(tools.length);
  const conversation: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let final: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        {
          model: config.anthropicModel,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: conversation,
          ...(tools.length > 0 ? { tools } : {}),
        },
        { signal },
      );
      stream.on("text", handlers.onText);
      final = await stream.finalMessage();
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (final.stop_reason !== "tool_use") {
      return;
    }

    const toolUses = final.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const outcomes = await Promise.all(toolUses.map(executeToolUse));
    for (const outcome of outcomes) {
      if (outcome.chart) {
        handlers.onChart(outcome.chart);
      }
      if (outcome.pendingOrder) {
        handlers.onPendingOrder(outcome.pendingOrder);
      }
    }
    conversation.push({ role: "assistant", content: final.content });
    conversation.push({ role: "user", content: outcomes.map((outcome) => outcome.block) });
  }

  throw new ChatError("stream_error", "The tool loop exceeded its round limit.");
}
