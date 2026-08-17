import { useCallback, useEffect, useState } from "react";
import type { OpenOrderView, PendingOrderView, PositionView } from "@nomo/shared";
import { fetchOpenOrders, fetchPositions, proposeCancelOrder, proposeClosePosition } from "../api";
import OrderCard from "./OrderCard";

interface Props {
  onBack: () => void;
}

function money(value: string | null): string {
  return value === null ? "" : `$${value}`;
}

export default function PortfolioView({ onBack }: Props) {
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrderView[]>([]);
  const [orders, setOrders] = useState<PendingOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchPositions(), fetchOpenOrders()])
      .then(([livePositions, liveOrders]) => {
        setPositions(livePositions);
        setOpenOrders(liveOrders);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load the portfolio."))
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

  const cancel = async (orderId: string) => {
    setProposing(orderId);
    setError(null);
    try {
      const { order } = await proposeCancelOrder(orderId);
      setOrders((current) => [order, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The cancel proposal failed.");
    } finally {
      setProposing(null);
    }
  };

  const updateOrder = (order: PendingOrderView) => {
    setOrders((current) => current.map((o) => (o.id === order.id ? order : o)));
    if (order.status === "executed") load();
  };

  const proposalIsLive = (o: PendingOrderView) =>
    o.status === "awaiting_confirmation" || o.status === "confirmed";

  // One live proposal per ticker: the button stays off until the card resolves.
  const hasOpenProposal = (symbol: string) =>
    orders.some((o) => o.action === "place" && o.ticker === symbol && proposalIsLive(o));

  // Same rule per resting order, keyed by the broker order reference.
  const hasCancelProposal = (orderId: string) =>
    orders.some((o) => o.action === "cancel" && o.brokerRef === orderId && proposalIsLive(o));

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
        <h3 className="portfolio-heading">Positions</h3>
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

        <h3 className="portfolio-heading">Open orders</h3>
        <div className="db-table-scroll portfolio-table">
          <table className="db-grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Quantity</th>
                <th>Type</th>
                <th>Limit</th>
                <th>State</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {openOrders.map((open) => (
                <tr key={open.orderId}>
                  <td>{open.symbol}</td>
                  <td>{open.side}</td>
                  <td>{open.quantity ?? ""}</td>
                  <td>{(open.orderType ?? "").replace("_", " ")}</td>
                  <td>{money(open.limitPrice)}</td>
                  <td>{open.state}</td>
                  <td>
                    <button
                      className="portfolio-close"
                      onClick={() => void cancel(open.orderId)}
                      disabled={proposing !== null || hasCancelProposal(open.orderId)}
                    >
                      {proposing === open.orderId ? "Proposing..." : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
              {openOrders.length === 0 && (
                <tr>
                  <td className="muted" colSpan={7}>
                    {loading ? "Loading…" : "No resting orders."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted portfolio-note">
          Cancel proposes cancelling the resting order at the broker. It also stops at the confirmation card and sends
          nothing until you confirm.
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
