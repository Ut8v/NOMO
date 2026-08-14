import { useCallback, useEffect, useState } from "react";
import type { PendingOrderView, PositionView } from "@nomo/shared";
import { fetchPositions, proposeClosePosition } from "../api";
import OrderCard from "./OrderCard";

interface Props {
  onBack: () => void;
}

function money(value: string | null): string {
  return value === null ? "" : `$${value}`;
}

export default function PortfolioView({ onBack }: Props) {
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<PendingOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchPositions()
      .then(setPositions)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load positions."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const close = async (symbol: string) => {
    setProposing(symbol);
    setError(null);
    try {
      const { order } = await proposeClosePosition(symbol);
      setOrders((current) => [order, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The close proposal failed.");
    } finally {
      setProposing(null);
    }
  };

  const updateOrder = (order: PendingOrderView) => {
    setOrders((current) => current.map((o) => (o.id === order.id ? order : o)));
    if (order.status === "executed") load();
  };

  // One live proposal per ticker: the button stays off until the card resolves.
  const hasOpenProposal = (symbol: string) =>
    orders.some((o) => o.ticker === symbol && (o.status === "awaiting_confirmation" || o.status === "confirmed"));

  return (
    <div className="db-view">
      <header className="chat-header">
        <div className="chat-header-left">
          <button className="icon-button" onClick={onBack} aria-label="Back to chat" title="Back to chat">
            <BackIcon />
          </button>
          <span className="chat-title">Portfolio</span>
        </div>
        <div className="chat-header-actions">
          <button className="link-button" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      <div className="portfolio-body">
        {error && <p className="error-text">{error}</p>}
        <div className="db-table-scroll portfolio-table">
          <table className="db-grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Quantity</th>
                <th>Avg cost</th>
                <th>Market value</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.symbol}>
                  <td>{position.symbol}</td>
                  <td>{position.side}</td>
                  <td>{position.quantity}</td>
                  <td>{money(position.averageBuyPrice)}</td>
                  <td>{money(position.marketValue)}</td>
                  <td>
                    {position.side === "long" && (
                      <button
                        className="portfolio-close"
                        onClick={() => void close(position.symbol)}
                        disabled={proposing !== null || hasOpenProposal(position.symbol)}
                      >
                        {proposing === position.symbol ? "Proposing..." : "Close"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {positions.length === 0 && (
                <tr>
                  <td className="muted" colSpan={6}>
                    {loading ? "Loading…" : "No open positions."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted portfolio-note">
          Close proposes a market sell of the whole position. Nothing reaches Robinhood until you confirm the order
          below, and the proposal expires after 5 minutes.
        </p>
        {orders.map((order) => (
          <OrderCard key={order.id} order={order} onResolved={updateOrder} />
        ))}
      </div>
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
