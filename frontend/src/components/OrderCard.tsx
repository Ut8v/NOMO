import { useEffect, useState } from "react";
import type { PendingOrderView } from "@nomo/shared";
import { confirmOrder, rejectOrder } from "../api";

interface Props {
  order: PendingOrderView;
  onResolved: (order: PendingOrderView) => void;
}

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_confirmation: "Awaiting your confirmation",
  confirmed: "Confirming...",
  rejected: "Rejected",
  expired: "Expired without confirmation",
  executed: "Executed",
  failed: "Failed",
};

export default function OrderCard({ order, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(() => remainingSeconds(order.expiresAt));

  const awaiting = order.status === "awaiting_confirmation" && secondsLeft > 0;
  const displayStatus =
    order.status === "awaiting_confirmation" && secondsLeft === 0 ? "expired" : order.status;

  useEffect(() => {
    if (order.status !== "awaiting_confirmation") return;
    const timer = window.setInterval(() => {
      setSecondsLeft(remainingSeconds(order.expiresAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [order.status, order.expiresAt]);

  async function act(action: (id: string) => Promise<{ order: PendingOrderView }>) {
    setBusy(true);
    setError(null);
    try {
      const response = await action(order.id);
      onResolved(response.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`order-card order-${displayStatus}`}>
      <div className="order-card-header">
        <span className="order-card-title">
          {order.action === "cancel"
            ? `Cancel order ${order.brokerRef ?? ""}`.trim()
            : `${order.side?.toUpperCase() ?? ""} ${order.quantity ?? ""} ${order.ticker}`.trim()}
        </span>
        <span className={`order-status order-status-${displayStatus}`}>
          {STATUS_LABELS[displayStatus] ?? displayStatus}
        </span>
      </div>

      <dl className="order-details">
        <div>
          <dt>{order.action === "cancel" ? "Target order" : "Order type"}</dt>
          <dd>
            {order.action === "cancel"
              ? `${order.ticker} order ${order.brokerRef ?? ""}`.trim()
              : `${order.orderType ?? ""}${order.limitPrice ? ` at $${order.limitPrice}` : ""}`}
          </dd>
        </div>
        <div>
          <dt>Rationale</dt>
          <dd>{order.rationale}</dd>
        </div>
        {order.result && (
          <div>
            <dt>{order.status === "failed" ? "Error" : "Broker response"}</dt>
            <dd className="order-result">{order.result}</dd>
          </div>
        )}
        {order.rejectReason && (
          <div>
            <dt>Reject reason</dt>
            <dd>{order.rejectReason}</dd>
          </div>
        )}
      </dl>

      {awaiting && (
        <div className="order-review">
          <input
            className="order-reason"
            type="text"
            placeholder="Optional: why are you rejecting? (helps NOMO learn)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            disabled={busy}
            maxLength={300}
          />
          <div className="order-actions">
            <span className="muted">Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</span>
            <button className="danger" onClick={() => void act((id) => rejectOrder(id, rejectReason))} disabled={busy}>
              Reject
            </button>
            <button onClick={() => void act(confirmOrder)} disabled={busy}>
              {busy ? "Working..." : order.action === "cancel" ? "Confirm cancellation" : "Confirm order"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
