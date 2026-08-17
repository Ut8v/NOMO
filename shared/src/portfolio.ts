/**
 * Read-only equity position summary for the portfolio view. Numeric values
 * are the broker's decimal strings, passed through untouched; the UI renders
 * them and the close-position path reuses quantity verbatim.
 */
export interface PositionView {
  symbol: string;
  quantity: string;
  averageBuyPrice: string | null;
  marketValue: string | null;
  side: "long" | "short";
}

/**
 * A resting (still cancellable) equity order for the portfolio view. Broker
 * values are passed through as strings; orderId is the broker's own order id
 * and is what a cancel proposal references.
 */
export interface OpenOrderView {
  orderId: string;
  symbol: string;
  side: string;
  quantity: string | null;
  orderType: string | null;
  limitPrice: string | null;
  state: string;
  createdAt: string | null;
}
