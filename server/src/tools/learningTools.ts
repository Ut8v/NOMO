import { createMemory } from "../db/memories.js";
import { insertOutcome, listOutcomes } from "../db/outcomes.js";
import { getPendingOrder } from "../db/pendingOrders.js";
import { searchMessages } from "../db/search.js";
import { distillLessons } from "../services/distill.js";
import { computePerformance, extractTags } from "../services/performance.js";
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

  registerTool({
    name: "record_outcome",
    tier: "market_data",
    description:
      "Record the realized profit or loss of a closed position from a previously confirmed order, so the track record can be reviewed later. Read the realized P/L from the Robinhood order or position tools; do not estimate it. Tags are taken from the original order's rationale.",
    inputSchema: {
      type: "object",
      properties: {
        pending_order_id: { type: "string", description: "Id of the original confirmed order" },
        realized_pl: {
          type: "number",
          description: "Realized profit (positive) or loss (negative) in dollars, read from Robinhood",
        },
      },
      required: ["pending_order_id", "realized_pl"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const raw = (input ?? {}) as { pending_order_id?: unknown; realized_pl?: unknown };
      const orderId = typeof raw.pending_order_id === "string" ? raw.pending_order_id : "";
      const realizedPl = typeof raw.realized_pl === "number" ? raw.realized_pl : Number.NaN;
      if (!orderId) throw new Error("pending_order_id is required.");
      if (!Number.isFinite(realizedPl)) throw new Error("realized_pl must be a number.");

      const order = getPendingOrder(orderId);
      if (!order) throw new Error("No order with that id.");
      if (order.status !== "executed") {
        throw new Error("Outcomes can only be recorded for orders that were confirmed and executed.");
      }

      const tags = extractTags(order.rationale);
      insertOutcome({ pendingOrderId: orderId, symbol: order.ticker, tags, realizedPl });
      return {
        forModel: {
          recorded: true,
          symbol: order.ticker,
          tags,
          note: "Outcome saved to the trade journal. Use review_performance to see the track record.",
        },
      };
    },
  });

  registerTool({
    name: "review_performance",
    tier: "market_data",
    description:
      "Compute the track record of confirmed trades grouped by the tags in their rationales (wins, losses, total and average P/L, win rate). The figures are computed deterministically; interpret them for the user, do not recompute them.",
    inputSchema: { type: "object", properties: {} },
    execute: async (): Promise<ToolExecutionResult> => {
      const outcomes = listOutcomes();
      const report = computePerformance(outcomes.map((o) => ({ tags: o.tags, realizedPl: o.realizedPl })));
      return { forModel: { tradesRecorded: outcomes.length, ...report } };
    },
  });

  registerTool({
    name: "search_history",
    tier: "market_data",
    description:
      "Search past conversations by keyword to recall what was discussed earlier. Returns matching conversations with a snippet. Use it when the user refers to something from a previous session.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for across past chats" },
      },
      required: ["query"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const query = typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : "";
      if (!query.trim()) throw new Error("query is required.");
      const hits = searchMessages(query, 10);
      return { forModel: { matches: hits, count: hits.length } };
    },
  });
}

