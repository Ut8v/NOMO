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
import { executeConfirmedOrder } from "./robinhoodMcp.js";

/**
 * The confirmation gate. Claude's execution tool calls land in proposeOrder
 * or proposeCancel, which only write a pending_orders row; the broker is
 * reached exclusively through confirmOrder, after the user clicked Confirm
 * and the row made the atomic awaiting_confirmation to confirmed transition
 * before its expiry.
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

function normalizeTicker(raw: unknown): string {
  const ticker = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) {
    throw new Error("ticker must be a stock symbol like AAPL.");
  }
  return ticker;
}

function normalizeRationale(raw: unknown): string {
  const rationale = typeof raw === "string" ? raw.trim() : "";
  if (!rationale) {
    throw new Error("rationale is required: state briefly why this action is proposed.");
  }
  return rationale.slice(0, MAX_RATIONALE_LENGTH);
}

function parseProposal(input: unknown): ParsedProposal {
  const raw = (input ?? {}) as Record<string, unknown>;
  const ticker = normalizeTicker(raw.ticker);

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

  return {
    ticker,
    side: raw.side,
    quantity: String(quantity),
    orderType: raw.order_type,
    limitPrice,
    rationale: normalizeRationale(raw.rationale),
  };
}

function pendingResult(order: PendingOrderView, note: string) {
  return {
    forModel: {
      status: "awaiting_confirmation",
      orderId: order.id,
      expiresAt: order.expiresAt,
      note,
    },
    order,
  };
}

export function proposeOrder(input: unknown): { forModel: unknown; order: PendingOrderView } {
  expireStaleOrders();
  const parsed = parseProposal(input);
  // The tool dispatcher writes the audit row for the proposal itself.
  const order = createPendingOrder({
    action: "place",
    ticker: parsed.ticker,
    side: parsed.side,
    quantity: parsed.quantity,
    orderType: parsed.orderType,
    limitPrice: parsed.limitPrice,
    brokerRef: null,
    rationale: parsed.rationale,
  });
  return pendingResult(
    order,
    "The order was NOT placed. The user must confirm it in the app within 5 minutes. Never state that it executed unless a later system record says so.",
  );
}

export function proposeCancel(input: unknown): { forModel: unknown; order: PendingOrderView } {
  expireStaleOrders();
  const raw = (input ?? {}) as Record<string, unknown>;
  const brokerRef = typeof raw.order_id === "string" ? raw.order_id.trim() : "";
  if (!brokerRef) {
    throw new Error("order_id is required: the broker order id to cancel, from get_equity_orders.");
  }
  const order = createPendingOrder({
    action: "cancel",
    ticker: normalizeTicker(raw.ticker),
    side: null,
    quantity: null,
    orderType: null,
    limitPrice: null,
    brokerRef,
    rationale: normalizeRationale(raw.rationale),
  });
  return pendingResult(
    order,
    "The cancellation was NOT sent. The user must confirm it in the app within 5 minutes. Never state that it was cancelled unless a later system record says so.",
  );
}

export interface ResearchedProposal {
  ticker: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number | null;
}

export interface ResearchContext {
  thesis: string;
  bearCase: string;
  /** Robinhood's pre-trade warnings from the mandatory simulation. */
  brokerWarnings: string | null;
}

/**
 * Creates a pending order from an orchestrated proposal. It runs the SAME
 * validation as a direct proposeOrder call and then only writes a
 * pending_orders row; it never reaches the broker. The research context
 * (thesis, bear case, broker warnings) is stored for the confirmation card.
 * This is a proposal path, not an execution path: the gate to the broker is
 * still confirmOrder, unchanged.
 */
export function proposeResearchedOrder(
  proposal: ResearchedProposal,
  context: ResearchContext,
): { forModel: unknown; order: PendingOrderView } {
  expireStaleOrders();
  const parsed = parseProposal({
    ticker: proposal.ticker,
    side: proposal.side,
    quantity: proposal.quantity,
    order_type: proposal.orderType,
    limit_price: proposal.limitPrice ?? undefined,
    rationale: context.thesis,
  });
  const order = createPendingOrder({
    action: "place",
    ticker: parsed.ticker,
    side: parsed.side,
    quantity: parsed.quantity,
    orderType: parsed.orderType,
    limitPrice: parsed.limitPrice,
    brokerRef: null,
    rationale: parsed.rationale,
    thesis: context.thesis,
    bearCase: context.bearCase,
    brokerWarnings: context.brokerWarnings,
  });
  return pendingResult(
    order,
    "The order was NOT placed. The user must confirm it in the app within 5 minutes. Never state that it executed unless a later system record says so.",
  );
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
    const ack = await executeConfirmedOrder(confirmed);
    markOrderExecuted(id, ack);
    recordToolCall({
      toolName: confirmed.action === "cancel" ? "cancel_equity_order" : "place_equity_order",
      tier: "execution",
      params: { orderId: id, action: confirmed.action, ticker: confirmed.ticker, brokerRef: confirmed.brokerRef, side: confirmed.side, quantity: confirmed.quantity, orderType: confirmed.orderType, limitPrice: confirmed.limitPrice },
      outcome: "executed",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Order placement failed.";
    markOrderFailed(id, message);
    recordToolCall({
      toolName: confirmed.action === "cancel" ? "cancel_equity_order" : "place_equity_order",
      tier: "execution",
      params: { orderId: id, action: confirmed.action },
      outcome: `error: ${message}`,
    });
  }
  return { ok: true, order: getPendingOrder(id)! };
}

const MAX_REJECT_REASON_LENGTH = 300;

export function rejectOrder(id: string, reason?: string): GateActionResult {
  expireStaleOrders();
  const existing = getPendingOrder(id);
  if (!existing) {
    return { ok: false, code: "not_found", order: null };
  }
  const trimmedReason = typeof reason === "string" ? reason.trim().slice(0, MAX_REJECT_REASON_LENGTH) : "";
  if (!rejectPendingOrder(id, trimmedReason || null)) {
    return { ok: false, code: "conflict", order: getPendingOrder(id) };
  }
  recordToolCall({
    toolName: existing.action === "cancel" ? "cancel_equity_order" : "place_equity_order",
    tier: "execution",
    params: { orderId: id, action: existing.action, reason: trimmedReason || undefined },
    outcome: "rejected by user",
  });
  return { ok: true, order: getPendingOrder(id)! };
}

export function getOrder(id: string): PendingOrderView | null {
  expireStaleOrders();
  return getPendingOrder(id);
}
