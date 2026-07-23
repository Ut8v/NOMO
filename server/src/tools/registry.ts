import type Anthropic from "@anthropic-ai/sdk";
import type { ChartSpec, PendingOrderView } from "@nomo/shared";
import { isTierEnabled } from "../db/settings.js";

/**
 * Every tool the model can see is registered here with an explicit tier.
 * The tier decides how a call is handled:
 *   market_data and portfolio_read execute immediately,
 *   execution never runs directly and must go through the confirmation gate.
 */
export type ToolTier = "market_data" | "portfolio_read" | "execution";

export interface ToolExecutionResult {
  /** JSON-serialized into the tool_result the model sees. Keep it compact. */
  forModel: unknown;
  /** Full chart spec streamed to the frontend, never sent to the model. */
  chart?: ChartSpec;
  /** Pending order streamed to the frontend as a confirmation card. */
  pendingOrder?: PendingOrderView;
}

export interface RegisteredTool {
  name: string;
  tier: ToolTier;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  execute: (input: unknown) => Promise<ToolExecutionResult>;
}

const tools = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool): void {
  if (tools.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  tools.set(tool.name, tool);
}

export function unregisterTool(name: string): void {
  tools.delete(name);
}

/**
 * Tools currently exposed to the model. A disabled tier is filtered here,
 * which is what removes its tools from the schema sent to Claude rather
 * than merely blocking calls.
 */
export function getEnabledTools(): RegisteredTool[] {
  return [...tools.values()].filter((tool) => isTierEnabled(tool.tier));
}

/** All registered tools regardless of tier setting, for the settings panel. */
export function getAllTools(): RegisteredTool[] {
  return [...tools.values()];
}

export function getToolSchemas(): Anthropic.Tool[] {
  return getEnabledTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}
