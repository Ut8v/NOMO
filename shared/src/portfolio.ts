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
