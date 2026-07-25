import { proposeOrder } from "../services/executionGate.js";
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
      "Propose an equity order. This does NOT place the order: it creates a proposal the user must explicitly confirm in the app within 5 minutes, and the broker is only contacted after that confirmation. Always give a clear one or two sentence rationale.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number", description: "Share count, fractional allowed" },
        order_type: { type: "string", enum: ["market", "limit"] },
        limit_price: { type: "number", description: "Required for limit orders" },
        rationale: { type: "string", description: "Why this trade is proposed" },
      },
      required: ["ticker", "side", "quantity", "order_type", "rationale"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const { forModel, order } = proposeOrder(input);
      return { forModel, pendingOrder: order };
    },
  });
}
