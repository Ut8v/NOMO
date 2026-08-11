import type Anthropic from "@anthropic-ai/sdk";
import type { ChartSpec, Findings, ToolEvent } from "@nomo/shared";
import { parseFindings } from "@nomo/shared";
import { recordToolCall } from "../db/auditLog.js";
import { recordUsage } from "../db/usage.js";
import { createAnthropicClient, specialistModel } from "../services/anthropic.js";
import { estimateCostUsd } from "../services/pricing.js";
import type { TokenUsage } from "../services/pricing.js";
import { getTool } from "../tools/registry.js";
import { AGENT_CLUSTERS, clusterAllows, clusterToolSchemas } from "./clusters.js";
import type { ClusterName } from "./clusters.js";

/**
 * A research specialist: a narrow, server-side Claude sub-loop that can only
 * see its own cluster's read tools and must finish by returning a validated
 * findings object. It never writes prose and never holds an execution tool.
 */

const MAX_ROUNDS = 6;
const MAX_TOKENS = 2048;

export interface SpecialistDef {
  /** Stable id used for audit tagging, cost attribution, and lane display. */
  name: string;
  cluster: ClusterName;
  /** Whether this specialist runs unless explicitly toggled; options is off. */
  defaultEnabled: boolean;
  /** One line describing what this specialist investigates. */
  focus: string;
}

export const SPECIALISTS: SpecialistDef[] = [
  { name: "screener", cluster: "screener", defaultEnabled: true, focus: "surface candidate tickers and setups from scanners and watchlists" },
  { name: "technicals", cluster: "technicals", defaultEnabled: true, focus: "price structure, momentum, key levels, and the recent trend" },
  { name: "fundamentals", cluster: "fundamentals", defaultEnabled: true, focus: "valuation, financial trends, and the earnings setup" },
  { name: "filings", cluster: "filings", defaultEnabled: true, focus: "recent SEC filings, material 8-K events, insider transactions, and the earnings calendar" },
  { name: "news", cluster: "news", defaultEnabled: true, focus: "recent news headlines, the current narrative, and near-term catalysts" },
  { name: "portfolio_risk", cluster: "portfolio_risk", defaultEnabled: true, focus: "current exposure, concentration, realized and unrealized P/L, and tax lots" },
  { name: "options", cluster: "options", defaultEnabled: false, focus: "options positioning, implied volatility, and chain structure" },
];

const EMIT_FINDINGS_TOOL: Anthropic.Tool = {
  name: "emit_findings",
  description:
    "Return your research as structured findings. Call this exactly once, as your final action, instead of writing any prose.",
  input_schema: {
    type: "object",
    properties: {
      ticker: { type: "string", description: "Symbol the findings concern, or PORTFOLIO for account-wide work." },
      signals: {
        type: "array",
        description: "Observations, each with a direction and a confidence from 0 to 1.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short label, e.g. RSI(14) or revenue growth YoY." },
            value: { type: "string", description: "The value straight from tool output; do not compute new numbers." },
            direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
            confidence: { type: "number", description: "0 to 1" },
          },
          required: ["name", "value", "direction", "confidence"],
        },
      },
      sources: { type: "array", items: { type: "string" }, description: "Tool names the signals came from." },
    },
    required: ["ticker", "signals"],
  },
};

export interface SpecialistEventSink {
  onToolEvent?: (event: ToolEvent) => void;
  onChart?: (spec: ChartSpec) => void;
}

export interface SpecialistOutcome {
  agent: string;
  /** Null when the specialist failed, timed out, or never emitted valid findings. */
  findings: Findings | null;
  error?: string;
  costUsd: number;
  tokens: { input: number; output: number };
}

function buildSpecialistPrompt(def: SpecialistDef): string {
  return [
    `You are the ${def.name} research specialist inside NOMO, a trading assistant.`,
    `Your job: ${def.focus}.`,
    "Rules:",
    "- Use only the tools provided. They are read-only market and account data.",
    "- You cannot place, cancel, or change orders; no such tool exists for you. Do not attempt it.",
    "- Every signal value must come from tool output. Never invent or recompute numbers.",
    "- Investigate efficiently, then call emit_findings exactly once with your signals.",
    "- Do not write prose. Your entire answer is the emit_findings call.",
    "- If the tools reveal nothing useful, call emit_findings with an empty signals array.",
  ].join("\n");
}

async function dispatchClusterTool(
  def: SpecialistDef,
  block: Anthropic.ToolUseBlock,
  sink: SpecialistEventSink,
): Promise<Anthropic.ToolResultBlockParam> {
  const deny = (outcome: string, content: string): Anthropic.ToolResultBlockParam => {
    recordToolCall({ toolName: block.name, tier: getTool(block.name)?.tier ?? "unknown", params: block.input, outcome, agent: def.name });
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content };
  };

  if (!clusterAllows(def.cluster, block.name)) {
    return deny("blocked: outside cluster", `Tool ${block.name} is not available to the ${def.name} specialist.`);
  }
  const tool = getTool(block.name);
  if (!tool) {
    return deny("rejected: unknown tool", `Unknown tool: ${block.name}`);
  }
  // Hard stop: a specialist may never reach an execution-tier tool, even if a
  // cluster were ever misconfigured to list one.
  if (tool.tier === "execution") {
    return deny("blocked: execution tool denied to specialist", `Tool ${block.name} is not available to any research agent.`);
  }

  try {
    const result = await tool.execute(block.input);
    if (result.chart) sink.onChart?.(result.chart);
    let content: string;
    try {
      content = JSON.stringify(result.forModel) ?? "null";
    } catch {
      return deny("error: unserializable result", `The ${tool.name} tool returned a malformed result.`);
    }
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: "ok", agent: def.name });
    return { type: "tool_result", tool_use_id: block.id, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed.";
    recordToolCall({ toolName: tool.name, tier: tool.tier, params: block.input, outcome: `error: ${message}`, agent: def.name });
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: message };
  }
}

export async function runSpecialist(
  def: SpecialistDef,
  task: string,
  sink: SpecialistEventSink = {},
  signal?: AbortSignal,
): Promise<SpecialistOutcome> {
  const client = createAnthropicClient();
  const model = specialistModel();
  const toolSchemas = [...clusterToolSchemas(def.cluster), EMIT_FINDINGS_TOOL];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const system = buildSpecialistPrompt(def);
  const conversation: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  let retriedSchema = false;
  let nudged = false;

  const finish = (findings: Findings | null, error?: string): SpecialistOutcome => {
    const costUsd = estimateCostUsd(model, usage);
    recordUsage({ model, ...usage, costUsd, agent: def.name });
    return { agent: def.name, findings, error, costUsd, tokens: { input: usage.inputTokens, output: usage.outputTokens } };
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let final: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        { model, max_tokens: MAX_TOKENS, system, messages: conversation, tools: toolSchemas },
        { signal },
      );
      final = await stream.finalMessage();
    } catch (err) {
      // An abort or API failure means this specialist simply reports missing.
      return finish(null, err instanceof Error ? err.message : "specialist error");
    }

    usage.inputTokens += final.usage.input_tokens;
    usage.outputTokens += final.usage.output_tokens;
    usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += final.usage.cache_creation_input_tokens ?? 0;

    const toolUses = final.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Prose with no findings: nudge once toward emit_findings, then give up.
      if (nudged) return finish(null, "specialist did not emit findings");
      nudged = true;
      conversation.push({ role: "assistant", content: final.content });
      conversation.push({ role: "user", content: "You must call emit_findings with your structured findings. Do not reply in prose." });
      continue;
    }

    const emit = toolUses.find((block) => block.name === "emit_findings");
    if (emit) {
      const parsed = parseFindings(emit.input);
      if (parsed.ok) return finish(parsed.findings);
      if (retriedSchema) return finish(null, `invalid findings: ${parsed.error}`);
      retriedSchema = true;
      conversation.push({ role: "assistant", content: final.content });
      conversation.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: emit.id,
            is_error: true,
            content: `Findings rejected: ${parsed.error} Call emit_findings again with a valid object.`,
          },
        ],
      });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const tier = getTool(block.name)?.tier ?? "unknown";
      sink.onToolEvent?.({ id: block.id, name: block.name, tier, phase: "start", agent: def.name });
      const result = await dispatchClusterTool(def, block, sink);
      sink.onToolEvent?.({ id: block.id, name: block.name, tier, phase: "end", ok: result.is_error !== true, agent: def.name });
      results.push(result);
    }
    conversation.push({ role: "assistant", content: final.content });
    conversation.push({ role: "user", content: results });
  }

  return finish(null, "specialist exceeded its round limit");
}

/** Exposed for defense-in-depth tests: the tools a specialist can ever see. */
export function specialistToolNames(def: SpecialistDef): string[] {
  return AGENT_CLUSTERS[def.cluster];
}
