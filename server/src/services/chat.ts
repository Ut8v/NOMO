import Anthropic from "@anthropic-ai/sdk";
import type { ChatErrorCode, ChatMessage } from "@nomo/shared";
import { config } from "../config.js";
import { getCredential } from "../db/credentials.js";
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
    ? `${base} Use the available tools when they help answer the question.`
    : `${base} No tools are available yet; say so if asked to fetch live data.`;
}

const MAX_TOKENS = 4096;

// Backstop against a tool call loop that never converges. Generous enough
// that legitimate multi step tool use in later phases will not hit it.
const MAX_TOOL_ROUNDS = 10;

async function executeToolUse(
  block: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = getTool(block.name);
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `Unknown tool: ${block.name}`,
      is_error: true,
    };
  }
  // Hard rule from CLAUDE.md: execution tier tools never run directly. The
  // confirmation gate (Phase 5) is the only path allowed to invoke them, so
  // this dispatcher refuses them unconditionally.
  if (tool.tier === "execution") {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content:
        "Execution tools require explicit user confirmation and cannot run from chat. The confirmation flow is not available yet.",
      is_error: true,
    };
  }
  try {
    const result = await tool.execute(block.input);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: JSON.stringify(result),
    };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: err instanceof Error ? err.message : "Tool execution failed.",
      is_error: true,
    };
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

/**
 * Runs one assistant turn: streams text to onText and resolves tool calls
 * in a loop until the model stops. The registry is empty in this phase, so
 * the loop body runs once, but later phases plug tools in without changes.
 */
export async function streamChatTurn(
  messages: ChatMessage[],
  onText: (text: string) => void,
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
      stream.on("text", onText);
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
    const results = await Promise.all(toolUses.map(executeToolUse));
    conversation.push({ role: "assistant", content: final.content });
    conversation.push({ role: "user", content: results });
  }

  throw new ChatError("stream_error", "The tool loop exceeded its round limit.");
}
