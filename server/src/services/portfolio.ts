import type { OpenOrderView, PendingOrderView, PositionView } from "@nomo/shared";
import { recordToolCall } from "../db/auditLog.js";
import { normalizeTicker, proposeCancel, proposeClosePosition as gateProposeClose } from "./executionGate.js";
import { fetchEquityOrders, fetchEquityPositions, simulateEquityOrder } from "./robinhoodMcp.js";

/**
 * Portfolio reads and the close-position proposal for the portfolio view.
 * Closing a position here is a proposal path like every other: the position's
 * quantity is read from the broker (never from the client), the order is
 * simulated, and a pending_orders row is written for the user to confirm.
 * The broker is still reached solely through the unchanged confirmation gate.
 */

/** Thrown for request problems the route should report as 4xx, not 502. */
export class PortfolioActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function decimalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Maps the broker's positions payload to typed views; unusable entries are dropped. */
export function parsePositions(raw: unknown): PositionView[] {
  // Tool results usually arrive as JSON text rather than structured content.
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const positions = (raw as { positions?: unknown } | null)?.positions;
  if (!Array.isArray(positions)) return [];
  return positions.flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const symbol = typeof record.symbol === "string" ? record.symbol.trim().toUpperCase() : "";
    const quantity = decimalString(record.quantity);
    if (!symbol || !quantity) return [];
    const view: PositionView = {
      symbol,
      quantity,
      averageBuyPrice: decimalString(record.average_buy_price),
      marketValue: decimalString(record.market_value),
      side: record.side === "short" ? "short" : "long",
    };
    return [view];
  });
}

export async function listPositions(): Promise<PositionView[]> {
  return parsePositions(await fetchEquityPositions());
}

// Orders in these states are done; everything else still rests at the broker
// and can be cancelled. Unknown states are treated as open so a cancellable
// order is never hidden by an unrecognized label.
const TERMINAL_ORDER_STATES = new Set(["filled", "cancelled", "canceled", "rejected", "failed", "expired", "voided"]);

/** Maps the broker's orders payload to typed views of the still-open orders. */
export function parseOpenOrders(raw: unknown): OpenOrderView[] {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const orders = (raw as { orders?: unknown } | null)?.orders;
  if (!Array.isArray(orders)) return [];
  return orders.flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const orderId = decimalString(record.id) ?? decimalString(record.order_id);
    const symbol = typeof record.symbol === "string" ? record.symbol.trim().toUpperCase() : "";
    const state = typeof record.state === "string" ? record.state.toLowerCase() : "";
    if (!orderId || !symbol || TERMINAL_ORDER_STATES.has(state)) return [];
    const view: OpenOrderView = {
      orderId,
      symbol,
      side: typeof record.side === "string" ? record.side : "",
      quantity: decimalString(record.quantity),
      orderType: typeof record.type === "string" ? record.type : null,
      limitPrice: decimalString(record.limit_price),
      state: state || "unknown",
      createdAt: typeof record.created_at === "string" ? record.created_at : null,
    };
    return [view];
  });
}

export async function listOpenOrders(): Promise<OpenOrderView[]> {
  return parseOpenOrders(await fetchEquityOrders());
}

/**
 * Builds a gated cancel proposal for a resting order. The order must exist in
 * the broker's live order list; the ticker and reference stored on the
 * proposal come from that listing, never from the client.
 */
export async function proposeCancelOpenOrder(rawOrderId: unknown): Promise<PendingOrderView> {
  const orderId = typeof rawOrderId === "string" ? rawOrderId.trim() : "";
  if (!orderId) {
    throw new PortfolioActionError("orderId is required.", 400);
  }

  const openOrders = await listOpenOrders();
  const target = openOrders.find((o) => o.orderId === orderId);
  if (!target) {
    throw new PortfolioActionError(`No open order ${orderId} was found.`, 404);
  }

  const describeSize = target.quantity ? `${target.quantity} share ` : "";
  const { order } = proposeCancel({
    order_id: target.orderId,
    ticker: target.symbol,
    rationale: `User-initiated cancellation of the resting ${target.side} ${describeSize}${target.symbol} order from the portfolio view.`,
  });
  recordToolCall({
    toolName: "cancel_order",
    tier: "execution",
    params: { orderId: target.orderId, ticker: target.symbol },
    outcome: "proposed, awaiting confirmation",
    agent: "portfolio",
  });
  return order;
}

/**
 * Builds a gated sell proposal that closes the full position in a ticker.
 * Fails without writing anything when the position does not exist or the
 * mandatory pre-trade simulation fails.
 */
export async function proposeClosePosition(rawTicker: unknown): Promise<PendingOrderView> {
  let ticker: string;
  try {
    ticker = normalizeTicker(rawTicker);
  } catch (err) {
    throw new PortfolioActionError(err instanceof Error ? err.message : "Invalid ticker.", 400);
  }

  const positions = await listPositions();
  const position = positions.find((p) => p.symbol === ticker && p.side === "long");
  if (!position) {
    throw new PortfolioActionError(`No open long position in ${ticker}.`, 404);
  }
  const quantity = Number(position.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new PortfolioActionError(`The ${ticker} position quantity is not sellable.`, 409);
  }

  const warnings = await simulateEquityOrder(
    { ticker, side: "sell", quantity: position.quantity, orderType: "market" },
    "portfolio",
  );

  const order = gateProposeClose(
    {
      ticker,
      quantity,
      rationale: `User-initiated close of the full ${position.quantity} share ${ticker} position from the portfolio view.`,
    },
    JSON.stringify(warnings),
  );
  recordToolCall({
    toolName: "close_position",
    tier: "execution",
    params: { ticker, quantity: position.quantity },
    outcome: "proposed, awaiting confirmation",
    agent: "portfolio",
  });
  return order;
}
