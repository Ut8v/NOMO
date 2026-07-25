import { createMemory } from "../db/memories.js";
import { distillLessons } from "../services/distill.js";
import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";

const MAX_MEMORY_LENGTH = 500;

/**
 * Learning loop tools. All sit at the market_data tier (local, auto
 * executing, no broker contact). None of them can influence the
 * confirmation gate; they only record or read back the user's history so
 * Claude can personalize proposals.
 */
export function registerLearningTools(): void {
  registerTool({
    name: "remember",
    tier: "market_data",
    description:
      "Record a durable fact about the user as a trader: risk tolerance, position size limits, watched tickers, or strategy preferences. Use it for lasting preferences worth recalling in future sessions, not passing chat details. The user can review, edit, or delete memories in settings.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "One concise fact about the user" },
      },
      required: ["content"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const content = typeof (input as { content?: unknown }).content === "string"
        ? (input as { content: string }).content.trim()
        : "";
      if (!content) {
        throw new Error("content is required: a short, durable fact about the user.");
      }
      const memory = createMemory({
        content: content.slice(0, MAX_MEMORY_LENGTH),
        source: "conversation",
        status: "approved",
      });
      return {
        forModel: {
          remembered: true,
          id: memory.id,
          note: "Saved as a background fact. The user can edit or remove it in settings.",
        },
      };
    },
  });

  registerTool({
    name: "distill_lessons",
    tier: "market_data",
    description:
      "Review the user's recent confirm and reject history, including their rejection reasons, and propose durable lessons about their preferences. Candidates are written to a review list in settings and are never used until the user approves them. Invoke when the user asks you to learn from their past decisions.",
    inputSchema: { type: "object", properties: {} },
    execute: async (): Promise<ToolExecutionResult> => {
      const result = await distillLessons();
      return { forModel: result };
    },
  });
}
