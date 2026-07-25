/**
 * Pending order types for the execution confirmation gate. An execution
 * tool call from the model only ever creates one of these; nothing reaches
 * the broker until the user confirms in the UI.
 */

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderAction = "place" | "cancel";

export type PendingOrderStatus =
  | "awaiting_confirmation"
  | "confirmed"
  | "rejected"
  | "expired"
  | "executed"
  | "failed";

export interface PendingOrderView {
  id: string;
  /** "place" proposes a new order; "cancel" proposes cancelling an existing one. */
  action: OrderAction;
  ticker: string;
  /** Null for cancel proposals. */
  side: OrderSide | null;
  quantity: string | null;
  orderType: OrderType | null;
  limitPrice: string | null;
  /** Broker order id to cancel; null for place proposals. */
  brokerRef: string | null;
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
