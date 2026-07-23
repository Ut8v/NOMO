import type { OrderSide, OrderType, PendingOrderView } from "@nomo/shared";
import { recordToolCall } from "../db/auditLog.js";
import {
  confirmPendingOrder,
  createPendingOrder,
  expireStaleOrders,
  getPendingOrder,
  markOrderExecuted,
  markOrderFailed,
  rejectPendingOrder,
} from "../db/pendingOrders.js";
import { placeConfirmedOrder } from "./robinhoodMcp.js";

/**
 * The confirmation gate. Claude's execution tool calls land in proposeOrder,
 * which only writes a pending_orders row; the broker is reached exclusively
 * through confirmOrder, after the user clicked Confirm and the row made the
 * atomic awaiting_confirmation to confirmed transition before its expiry.
 */

const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const MAX_QUANTITY = 100_000;
const MAX_RATIONALE_LENGTH = 2_000;

interface ParsedProposal {
  ticker: string;
  side: OrderSide;
  quantity: string;
  orderType: OrderType;
  limitPrice: string | null;
  rationale: string;
}

function parseProposal(input: unknown): ParsedProposal {
  const raw = (input ?? {}) as Record<string, unknown>;

  const ticker = typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) {
    throw new Error("ticker must be a stock symbol like AAPL.");
  }

  if (raw.side !== "buy" && raw.side !== "sell") {
    throw new Error("side must be buy or sell.");
  }

  const quantity = typeof raw.quantity === "number" ? raw.quantity : Number.NaN;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    throw new Error(`quantity must be a number between 0 and ${MAX_QUANTITY}.`);
  }

  if (raw.order_type !== "market" && raw.order_type !== "limit") {
    throw new Error("order_type must be market or limit.");
  }

  let limitPrice: string | null = null;
  if (raw.order_type === "limit") {
    const price = typeof raw.limit_price === "number" ? raw.limit_price : Number.NaN;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("limit_price must be a positive number for limit orders.");
    }
    limitPrice = String(price);
  }

  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) {
    throw new Error("rationale is required: state briefly why this trade is proposed.");
  }

  return {
    ticker,
    side: raw.side,
    quantity: String(quantity),
    orderType: raw.order_type,
    limitPrice,
    rationale: rationale.slice(0, MAX_RATIONALE_LENGTH),
  };
}

export function proposeOrder(input: unknown): { forModel: unknown; order: PendingOrderView } {
  expireStaleOrders();
  const parsed = parseProposal(input);
  // The tool dispatcher writes the audit row for the proposal itself.
  const order = createPendingOrder(parsed);
  return {
    forModel: {
      status: "awaiting_confirmation",
      orderId: order.id,
      expiresAt: order.expiresAt,
      note: "The order was NOT placed. The user must confirm it in the app within 5 minutes. Never state that it executed unless a later system record says so.",
    },
    order,
  };
}

export type GateActionCode = "not_found" | "conflict";

export interface GateActionResult {
  ok: boolean;
  code?: GateActionCode;
  order: PendingOrderView | null;
}

export async function confirmOrder(id: string): Promise<GateActionResult> {
  expireStaleOrders();
  const existing = getPendingOrder(id);
  if (!existing) {
    return { ok: false, code: "not_found", order: null };
  }
  if (!confirmPendingOrder(id)) {
    // Already resolved, or the sweep above just expired it.
    return { ok: false, code: "conflict", order: getPendingOrder(id) };
  }

  const confirmed = getPendingOrder(id)!;
  try {
    const ack = await placeConfirmedOrder(confirmed);
    markOrderExecuted(id, ack);
    recordToolCall({
      toolName: "place_equity_order",
      tier: "execution",
      params: { orderId: id, ticker: confirmed.ticker, side: confirmed.side, quantity: confirmed.quantity, orderType: confirmed.orderType, limitPrice: confirmed.limitPrice },
      outcome: "executed",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Order placement failed.";
    markOrderFailed(id, message);
    recordToolCall({
      toolName: "place_equity_order",
      tier: "execution",
      params: { orderId: id },
      outcome: `error: ${message}`,
    });
  }
  return { ok: true, order: getPendingOrder(id)! };
}

export function rejectOrder(id: string): GateActionResult {
  expireStaleOrders();
  const existing = getPendingOrder(id);
  if (!existing) {
    return { ok: false, code: "not_found", order: null };
  }
  if (!rejectPendingOrder(id)) {
    return { ok: false, code: "conflict", order: getPendingOrder(id) };
  }
  recordToolCall({
    toolName: "place_equity_order",
    tier: "execution",
    params: { orderId: id },
    outcome: "rejected by user",
  });
  return { ok: true, order: getPendingOrder(id)! };
}

export function getOrder(id: string): PendingOrderView | null {
  expireStaleOrders();
  return getPendingOrder(id);
}
