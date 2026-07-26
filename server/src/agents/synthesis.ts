import type Anthropic from "@anthropic-ai/sdk";
import type { Findings, ToolEvent } from "@nomo/shared";
import { recordToolCall } from "../db/auditLog.js";
import { recordUsage } from "../db/usage.js";
import { createAnthropicClient, strongModel } from "../services/anthropic.js";
import { estimateCostUsd } from "../services/pricing.js";
import type { TokenUsage } from "../services/pricing.js";
import { getTool } from "../tools/registry.js";
import { AGENT_CLUSTERS, clusterAllows, clusterToolSchemas } from "./clusters.js";

/**
 * Synthesis and the risk-skeptic. Both run on the strong model. Synthesis reads
 * every specialist's findings and produces one thesis with at most one concrete
 * proposal; the skeptic attacks that thesis. Neither can place an order: the
 * only order tools synthesis sees are tradability and simulation reads, and the
 * skeptic gets no tools at all.
 */

const MAX_ROUNDS = 5;
const MAX_TOKENS = 2048;

export interface ProposalDraft {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit" | "stop_market" | "stop_limit";
  limitPrice?: number | null;
  stopPrice?: number | null;
}

export interface SynthesisResult {
  thesis: string;
  proposal: ProposalDraft | null;
  costUsd: number;
}

export interface SkepticResult {
  bearCase: string;
  costUsd: number;
}

export interface SynthesisSink {
  onToolEvent?: (event: ToolEvent) => void;
}

const EMIT_SYNTHESIS_TOOL: Anthropic.Tool = {
  name: "emit_synthesis",
  description:
    "Return your thesis and at most one concrete order proposal. Call this exactly once as your final action. Omit proposal (or set it null) when no trade is warranted.",
  input_schema: {
    type: "object",
    properties: {
      thesis: { type: "string", description: "One tight paragraph: the setup, the evidence, and the plan." },
      proposal: {
        type: ["object", "null"],
        description: "At most one equity order, or null for no trade.",
        properties: {
          ticker: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          quantity: { type: "number" },
          order_type: { type: "string", enum: ["market", "limit", "stop_market", "stop_limit"] },
          limit_price: { type: "number", description: "Required for limit and stop_limit orders." },
          stop_price: { type: "number", description: "Trigger price; required for stop_market and stop_limit orders." },
        },
        required: ["ticker", "side", "quantity", "order_type"],
      },
    },
    required: ["thesis"],
  },
};

const EMIT_BEAR_CASE_TOOL: Anthropic.Tool = {
  name: "emit_bear_case",
  description: "Return the bear case against the thesis. Call this exactly once as your final action.",
  input_schema: {
    type: "object",
    properties: {
      bear_case: {
        type: "string",
        description:
          "The strongest case against the proposal: missed factors, exposure and concentration objections, and tax lot consequences.",
      },
    },
    required: ["bear_case"],
  },
};

function renderFindings(findings: Array<{ agent: string; findings: Findings | null }>): string {
  return findings
    .map((entry) => {
      if (!entry.findings) return `## ${entry.agent}\n(no findings; specialist unavailable or timed out)`;
      const signals = entry.findings.signals
        .map((s) => `- ${s.name}: ${s.value} [${s.direction}, confidence ${s.confidence}]`)
        .join("\n");
      return `## ${entry.agent} (${entry.findings.ticker})\n${signals || "- no signals"}`;
    })
    .join("\n\n");
}

const DRAFT_TYPES = ["market", "limit", "stop_market", "stop_limit"];

function parseProposalDraft(raw: unknown): ProposalDraft | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.ticker !== "string" || !p.ticker.trim()) return null;
  if (p.side !== "buy" && p.side !== "sell") return null;
  if (typeof p.quantity !== "number" || !Number.isFinite(p.quantity) || p.quantity <= 0) return null;
  if (typeof p.order_type !== "string" || !DRAFT_TYPES.includes(p.order_type)) return null;
  const orderType = p.order_type as ProposalDraft["orderType"];
  const limitPrice = typeof p.limit_price === "number" ? p.limit_price : null;
  const stopPrice = typeof p.stop_price === "number" ? p.stop_price : null;
  const needsLimit = orderType === "limit" || orderType === "stop_limit";
  const needsStop = orderType === "stop_market" || orderType === "stop_limit";
  if (needsLimit && (limitPrice === null || limitPrice <= 0)) return null;
  if (needsStop && (stopPrice === null || stopPrice <= 0)) return null;
  return { ticker: p.ticker.trim().toUpperCase(), side: p.side, quantity: p.quantity, orderType, limitPrice, stopPrice };
}

async function dispatchSynthesisTool(
  block: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  const deny = (outcome: string, content: string): Anthropic.ToolResultBlockParam => {
    recordToolCall({ toolName: block.name, tier: getTool(block.name)?.tier ?? "unknown", params: block.input, outcome, agent: "synthesis" });
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content };
  };
  if (!clusterAllows("synthesis", block.name)) {
    return deny("blocked: outside cluster", `Tool ${block.name} is not available to synthesis.`);
  }
  const tool = getTool(block.name);
  if (!tool) return deny("rejected: unknown tool", `Unknown tool: ${block.name}`);
  if (tool.tier === "execution") {
    return deny("blocked: execution tool denied to synthesis", `Tool ${block.name} is not available to any research agent.`);
  }
  try {
    const result = await tool.execute(block.input);
    const content = JSON.stringify(result.forModel) ?? "null";
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: "ok", agent: "synthesis" });
    return { type: "tool_result", tool_use_id: block.id, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed.";
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: `error: ${message}`, agent: "synthesis" });
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: message };
  }
}

const SYNTHESIS_SYSTEM = [
  "You are the synthesis step of NOMO, a trading assistant.",
  "You receive structured findings from research specialists. Merge them into ONE thesis.",
  "Propose at most one concrete equity order, and only when the evidence clearly supports it; otherwise propose no trade.",
  "You cannot place orders. You may check tradability and simulate an order, nothing more.",
  "Do not fabricate figures; rely on the findings and your read tools.",
  "Finish by calling emit_synthesis exactly once. Do not write prose outside that call.",
].join("\n");

export async function runSynthesis(
  question: string,
  findings: Array<{ agent: string; findings: Findings | null }>,
  sink: SynthesisSink = {},
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const client = createAnthropicClient();
  const model = strongModel();
  const toolSchemas = [...clusterToolSchemas("synthesis"), EMIT_SYNTHESIS_TOOL];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const conversation: Anthropic.MessageParam[] = [
    { role: "user", content: `User request: ${question}\n\nSpecialist findings:\n\n${renderFindings(findings)}` },
  ];

  let nudged = false;
  const finish = (thesis: string, proposal: ProposalDraft | null): SynthesisResult => {
    const costUsd = estimateCostUsd(model, usage);
    recordUsage({ model, ...usage, costUsd, agent: "synthesis" });
    return { thesis, proposal, costUsd };
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let final: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        { model, max_tokens: MAX_TOKENS, system: SYNTHESIS_SYSTEM, messages: conversation, tools: toolSchemas },
        { signal },
      );
      final = await stream.finalMessage();
    } catch (err) {
      return finish(`Synthesis could not complete: ${err instanceof Error ? err.message : "error"}.`, null);
    }
    usage.inputTokens += final.usage.input_tokens;
    usage.outputTokens += final.usage.output_tokens;
    usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += final.usage.cache_creation_input_tokens ?? 0;

    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (nudged) return finish("No thesis was produced.", null);
      nudged = true;
      conversation.push({ role: "assistant", content: final.content });
      conversation.push({ role: "user", content: "Call emit_synthesis with your thesis now." });
      continue;
    }

    const emit = toolUses.find((b) => b.name === "emit_synthesis");
    if (emit) {
      const input = (emit.input ?? {}) as { thesis?: unknown; proposal?: unknown };
      const thesis = typeof input.thesis === "string" && input.thesis.trim() ? input.thesis.trim() : "No thesis provided.";
      return finish(thesis, parseProposalDraft(input.proposal));
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const tier = getTool(block.name)?.tier ?? "unknown";
      sink.onToolEvent?.({ id: block.id, name: block.name, tier, phase: "start", agent: "synthesis" });
      const result = await dispatchSynthesisTool(block);
      sink.onToolEvent?.({ id: block.id, name: block.name, tier, phase: "end", ok: result.is_error !== true, agent: "synthesis" });
      results.push(result);
    }
    conversation.push({ role: "assistant", content: final.content });
    conversation.push({ role: "user", content: results });
  }
  return finish("Synthesis exceeded its round limit.", null);
}

const SKEPTIC_SYSTEM = [
  "You are the risk-skeptic of NOMO. Your only job is to argue AGAINST the proposed trade.",
  "Given the thesis and the portfolio and risk findings, state the strongest bear case:",
  "missed factors, exposure and concentration objections, and tax lot consequences.",
  "Be specific and concise. Finish by calling emit_bear_case exactly once.",
].join("\n");

export async function runSkeptic(
  thesis: string,
  proposal: ProposalDraft,
  portfolioFindings: Findings | null,
  signal?: AbortSignal,
): Promise<SkepticResult> {
  const client = createAnthropicClient();
  const model = strongModel();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const portfolio = portfolioFindings
    ? renderFindings([{ agent: "portfolio_risk", findings: portfolioFindings }])
    : "(no portfolio or risk findings available)";
  const proposalText = `${proposal.side} ${proposal.quantity} ${proposal.ticker} (${proposal.orderType}${proposal.limitPrice ? ` at ${proposal.limitPrice}` : ""})`;

  const conversation: Anthropic.MessageParam[] = [
    { role: "user", content: `Proposed trade: ${proposalText}\n\nThesis:\n${thesis}\n\nPortfolio and risk:\n${portfolio}` },
  ];

  const finish = (bearCase: string): SkepticResult => {
    const costUsd = estimateCostUsd(model, usage);
    recordUsage({ model, ...usage, costUsd, agent: "skeptic" });
    return { bearCase, costUsd };
  };

  let nudged = false;
  for (let round = 0; round < 3; round++) {
    let final: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        { model, max_tokens: MAX_TOKENS, system: SKEPTIC_SYSTEM, messages: conversation, tools: [EMIT_BEAR_CASE_TOOL] },
        { signal },
      );
      final = await stream.finalMessage();
    } catch (err) {
      return finish(`Bear case unavailable: ${err instanceof Error ? err.message : "error"}.`);
    }
    usage.inputTokens += final.usage.input_tokens;
    usage.outputTokens += final.usage.output_tokens;
    usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += final.usage.cache_creation_input_tokens ?? 0;

    const emit = final.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "emit_bear_case",
    );
    if (emit) {
      const input = (emit.input ?? {}) as { bear_case?: unknown };
      const bearCase = typeof input.bear_case === "string" && input.bear_case.trim() ? input.bear_case.trim() : "No specific objections were raised.";
      return finish(bearCase);
    }
    if (nudged) return finish("No bear case was produced.");
    nudged = true;
    conversation.push({ role: "assistant", content: final.content });
    conversation.push({ role: "user", content: "Call emit_bear_case with your objections now." });
  }
  return finish("No bear case was produced.");
}

/** Exposed for tests: the tools synthesis can ever see. */
export function synthesisToolNames(): string[] {
  return AGENT_CLUSTERS.synthesis;
}
