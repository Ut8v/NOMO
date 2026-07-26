import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";
import { runResearch } from "../agents/orchestrator.js";

export const DEEP_RESEARCH_TOOL = "deep_research";

/**
 * Entry point to the multi-agent research orchestrator. It is registered so it
 * appears in the model's tool schema and honors the market_data tier toggle,
 * but the chat loop intercepts calls to it (see services/chat.ts) to run the
 * orchestrator with live sub-agent lane events. This registered execute path is
 * the no-live-events fallback and is otherwise identical.
 */
export function registerResearchTool(): void {
  registerTool({
    name: DEEP_RESEARCH_TOOL,
    tier: "market_data",
    description:
      "Run a full multi-agent research pass for a trade idea or a should-I-buy/sell question. Fans out screener, technicals, fundamentals, portfolio, and risk specialists, synthesizes one thesis, stress-tests it, and may propose a single order that the user must still confirm. Use this for analysis and trade decisions, not for a simple quote or chart.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The user's request or question to research, e.g. 'is there a window to buy NVDA this week?'",
        },
      },
      required: ["question"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const question = typeof (input as { question?: unknown }).question === "string"
        ? (input as { question: string }).question.trim()
        : "";
      if (!question) {
        throw new Error("question is required: what should the research pass investigate?");
      }
      const result = await runResearch(question);
      return { forModel: result.summary, pendingOrder: result.order ?? undefined };
    },
  });
}
