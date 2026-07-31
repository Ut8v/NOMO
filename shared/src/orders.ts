/**
 * Pending order types for the execution confirmation gate. An execution
 * tool call from the model only ever creates one of these; nothing reaches
 * the broker until the user confirms in the UI.
 */

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
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
  /** Share count; null for a notional (dollar_amount) order or a cancel. */
  quantity: string | null;
  /** USD notional for a dollar-based market order; null when priced by shares. */
  dollarAmount: string | null;
  orderType: OrderType | null;
  limitPrice: string | null;
  /** Stop trigger price for stop_market and stop_limit orders; null otherwise. */
  stopPrice: string | null;
  /** Broker order id to cancel; null for place proposals. */
  brokerRef: string | null;
  rationale: string;
  status: PendingOrderStatus;
  createdAt: string;
  expiresAt: string;
  /** Broker acknowledgment or error detail once resolved. */
  result: string | null;
  /** Optional one-line reason the user gave when rejecting. */
  rejectReason: string | null;
  /** Synthesis thesis behind an orchestrated proposal; null for direct orders. */
  thesis: string | null;
  /** The risk-skeptic's bear case for an orchestrated proposal. */
  bearCase: string | null;
  /** Robinhood's pre-trade warnings captured during the mandatory simulation. */
  brokerWarnings: string | null;
}

export interface OrderActionResponse {
  order: PendingOrderView;
}

/**
 * A cleaned pre-trade review for the confirmation card. Parsed from the broker's
 * raw review_equity_order response: the broker's own model-directed guidance is
 * dropped, its alerts are surfaced, and the compliance quote disclosure is kept
 * verbatim. Stored JSON-encoded in PendingOrderView.brokerWarnings.
 */
export interface BrokerReview {
  /** Broker order-check alerts, e.g. insufficient buying power. */
  alerts: string[];
  /** market_data_disclosure, shown verbatim for compliance. */
  disclosure: string | null;
  /** Short price context, e.g. limit vs bid/ask. */
  summary: string | null;
}
