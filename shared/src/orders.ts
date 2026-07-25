/**
 * Pending order types for the execution confirmation gate. An execution
 * tool call from the model only ever creates one of these; nothing reaches
 * the broker until the user confirms in the UI.
 */

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export type PendingOrderStatus =
  | "awaiting_confirmation"
  | "confirmed"
  | "rejected"
  | "expired"
  | "executed"
  | "failed";

export interface PendingOrderView {
  id: string;
  ticker: string;
  side: OrderSide;
  quantity: string;
  orderType: OrderType;
  limitPrice: string | null;
  rationale: string;
  status: PendingOrderStatus;
  createdAt: string;
  expiresAt: string;
  /** Broker acknowledgment or error detail once resolved. */
  result: string | null;
}

export interface OrderActionResponse {
  order: PendingOrderView;
}
