import { randomUUID } from "node:crypto";
import type { OrderSide, OrderType, PendingOrderStatus, PendingOrderView } from "@nomo/shared";
import { getDb } from "./index.js";

/**
 * Pending order storage for the confirmation gate. Status transitions are
 * single atomic UPDATEs guarded by the current status, so a double confirm
 * or a confirm after expiry can never slip through.
 */

const EXPIRY_MS = 5 * 60 * 1000;

interface PendingOrderRow {
  id: string;
  ticker: string;
  side: OrderSide;
  quantity: string;
  order_type: OrderType;
  limit_price: string | null;
  rationale: string;
  status: PendingOrderStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  result: string | null;
}

function toView(row: PendingOrderRow): PendingOrderView {
  return {
    id: row.id,
    ticker: row.ticker,
    side: row.side,
    quantity: row.quantity,
    orderType: row.order_type,
    limitPrice: row.limit_price,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    result: row.result,
  };
}

export interface NewPendingOrder {
  ticker: string;
  side: OrderSide;
  quantity: string;
  orderType: OrderType;
  limitPrice: string | null;
  rationale: string;
}

export function createPendingOrder(order: NewPendingOrder): PendingOrderView {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_MS).toISOString();
  getDb()
    .prepare(
      `INSERT INTO pending_orders (id, ticker, side, quantity, order_type, limit_price, rationale, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?)`,
    )
    .run(id, order.ticker, order.side, order.quantity, order.orderType, order.limitPrice, order.rationale, expiresAt);
  return getPendingOrder(id)!;
}

export function getPendingOrder(id: string): PendingOrderView | null {
  const row = getDb().prepare("SELECT * FROM pending_orders WHERE id = ?").get(id) as
    | PendingOrderRow
    | undefined;
  return row ? toView(row) : null;
}

/** Sweeps stale awaiting orders; called before every gate action. */
export function expireStaleOrders(): void {
  getDb()
    .prepare(
      `UPDATE pending_orders
       SET status = 'expired', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'awaiting_confirmation' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run();
}

function transition(id: string, from: PendingOrderStatus, to: PendingOrderStatus, extra?: { requireUnexpired?: boolean; result?: string }): boolean {
  const guards = extra?.requireUnexpired
    ? "AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    : "";
  const changes = getDb()
    .prepare(
      `UPDATE pending_orders
       SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), result = COALESCE(?, result)
       WHERE id = ? AND status = ? ${guards}`,
    )
    .run(to, extra?.result ?? null, id, from).changes;
  return changes === 1;
}

export function confirmPendingOrder(id: string): boolean {
  return transition(id, "awaiting_confirmation", "confirmed", { requireUnexpired: true });
}

export function rejectPendingOrder(id: string): boolean {
  return transition(id, "awaiting_confirmation", "rejected");
}

export function markOrderExecuted(id: string, result: string): boolean {
  return transition(id, "confirmed", "executed", { result });
}

export function markOrderFailed(id: string, error: string): boolean {
  return transition(id, "confirmed", "failed", { result: error });
}
