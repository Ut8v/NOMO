import { randomUUID } from "node:crypto";
import type { OrderAction, OrderSide, OrderType, PendingOrderStatus, PendingOrderView } from "@nomo/shared";
import { getDb } from "./index.js";

/**
 * Pending order storage for the confirmation gate. Status transitions are
 * single atomic UPDATEs guarded by the current status, so a double confirm
 * or a confirm after expiry can never slip through.
 */

const EXPIRY_MS = 5 * 60 * 1000;

interface PendingOrderRow {
  id: string;
  action: OrderAction;
  ticker: string;
  side: OrderSide | null;
  quantity: string | null;
  order_type: OrderType | null;
  limit_price: string | null;
  stop_price: string | null;
  broker_ref: string | null;
  rationale: string;
  status: PendingOrderStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  result: string | null;
  reject_reason: string | null;
  thesis: string | null;
  bear_case: string | null;
  broker_warnings: string | null;
}

function toView(row: PendingOrderRow): PendingOrderView {
  return {
    id: row.id,
    action: row.action,
    ticker: row.ticker,
    side: row.side,
    quantity: row.quantity,
    orderType: row.order_type,
    limitPrice: row.limit_price,
    stopPrice: row.stop_price,
    brokerRef: row.broker_ref,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    result: row.result,
    rejectReason: row.reject_reason,
    thesis: row.thesis,
    bearCase: row.bear_case,
    brokerWarnings: row.broker_warnings,
  };
}

export interface NewPendingOrder {
  action: OrderAction;
  ticker: string;
  side: OrderSide | null;
  quantity: string | null;
  orderType: OrderType | null;
  limitPrice: string | null;
  stopPrice?: string | null;
  brokerRef: string | null;
  rationale: string;
  /** Research context for orchestrated proposals; omitted for direct orders. */
  thesis?: string | null;
  bearCase?: string | null;
  brokerWarnings?: string | null;
}

export function createPendingOrder(order: NewPendingOrder): PendingOrderView {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_MS).toISOString();
  getDb()
    .prepare(
      `INSERT INTO pending_orders (id, action, ticker, side, quantity, order_type, limit_price, stop_price, broker_ref, rationale, status, expires_at, thesis, bear_case, broker_warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?, ?)`,
    )
    .run(
      id,
      order.action,
      order.ticker,
      order.side,
      order.quantity,
      order.orderType,
      order.limitPrice,
      order.stopPrice ?? null,
      order.brokerRef,
      order.rationale,
      expiresAt,
      order.thesis ?? null,
      order.bearCase ?? null,
      order.brokerWarnings ?? null,
    );
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

export function rejectPendingOrder(id: string, reason?: string | null): boolean {
  const rejected = transition(id, "awaiting_confirmation", "rejected");
  if (rejected && reason) {
    getDb().prepare("UPDATE pending_orders SET reject_reason = ? WHERE id = ?").run(reason, id);
  }
  return rejected;
}

/** Confirmed and executed orders with the veto reasons on the rejected ones. */
export function listResolvedOrders(limit = 100): PendingOrderView[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pending_orders
       WHERE status IN ('executed', 'rejected', 'confirmed', 'failed')
       ORDER BY resolved_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(limit) as PendingOrderRow[];
  return rows.map(toView);
}

export function markOrderExecuted(id: string, result: string): boolean {
  return transition(id, "confirmed", "executed", { result });
}

export function markOrderFailed(id: string, error: string): boolean {
  return transition(id, "confirmed", "failed", { result: error });
}
