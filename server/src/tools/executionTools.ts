import { proposeCancel, proposeOrder } from "../services/executionGate.js";
import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";

/**
 * The execution tier tool surface shown to Claude. Its execute path writes
 * a pending order and nothing else; the broker call lives behind the
 * confirmation gate and requires the user's explicit Confirm.
 */
export function registerExecutionTools(): void {
  registerTool({
    name: "place_equity_order",
    tier: "execution",
    description:
      "Propose an equity order. This does NOT place the order: it creates a proposal the user must explicitly confirm in the app within 5 minutes, and the broker is only contacted after that confirmation. Size the order by share count (quantity, fractional allowed) OR by a dollar amount (dollar_amount, market orders only), never both. Supports stop and stop-limit orders. Always give a clear one or two sentence rationale.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number", description: "Share count, fractional allowed. Provide this OR dollar_amount." },
        dollar_amount: { type: "number", description: "USD notional to buy or sell, e.g. 100 for $100. Market orders only. Provide this OR quantity." },
        order_type: {
          type: "string",
          enum: ["market", "limit", "stop_market", "stop_limit"],
          description: "market, limit, stop_market (sell/buy once the stop triggers, then market), or stop_limit (triggers, then a limit order)",
        },
        limit_price: { type: "number", description: "Required for limit and stop_limit orders" },
        stop_price: { type: "number", description: "Trigger price; required for stop_market and stop_limit orders" },
        rationale: { type: "string", description: "Why this trade is proposed" },
      },
      required: ["ticker", "side", "order_type", "rationale"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const { forModel, order } = proposeOrder(input);
      return { forModel, pendingOrder: order };
    },
  });

  registerTool({
    name: "cancel_equity_order",
    tier: "execution",
    description:
      "Propose cancelling an existing equity order. This does NOT cancel it: it creates a proposal the user must explicitly confirm in the app within 5 minutes. Look up the broker order id first with get_equity_orders. Always give a short rationale.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Broker order id to cancel, from get_equity_orders" },
        ticker: { type: "string", description: "Symbol of that order, for display, e.g. AAPL" },
        rationale: { type: "string", description: "Why this cancellation is proposed" },
      },
      required: ["order_id", "ticker", "rationale"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const { forModel, order } = proposeCancel(input);
      return { forModel, pendingOrder: order };
    },
  });
}
