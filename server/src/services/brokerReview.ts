import type { BrokerReview } from "@nomo/shared";

/**
 * Turns Robinhood's raw review_equity_order response into a clean summary for
 * the confirmation card. Three things happen here:
 *   - the broker's `guide` field (instructions aimed at the model) is dropped
 *     entirely and never surfaced to the user,
 *   - `order_checks` alerts are pulled out and made human-readable,
 *   - `market_data_disclosure` is preserved verbatim for compliance.
 * Everything is best-effort and defensive: an unexpected shape degrades to a
 * safe, empty-ish review rather than throwing.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function money(value: unknown): string | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function parseAlerts(checks: unknown): string[] {
  const c = asRecord(checks);
  if (!c) return [];
  const alertType = typeof c.alertType === "string" ? c.alertType : null;
  if (!alertType) return [];

  if (alertType === "EQUITY_NOT_ENOUGH_BP") {
    const details = asRecord(c.equityNotEnoughBpAlertDetails);
    const deposit = money(asRecord(details?.depositAmount)?.amount);
    return [`Insufficient buying power${deposit ? ` — about $${deposit} short of this order` : ""}.`];
  }
  // Unknown alert: surface it readably rather than hiding it.
  return [`Broker alert: ${alertType.toLowerCase().replace(/_/g, " ")}.`];
}

function buildSummary(data: Record<string, unknown>): string | null {
  const quote = asRecord(data.quote_data);
  const bid = money(quote?.bid_price);
  const ask = money(quote?.ask_price);
  const last = money(quote?.last_trade_price);
  const limit = money(data.limit_price);
  const stop = money(data.stop_price);
  const estimated = money(data.estimated_cost);

  const head: string[] = [];
  if (stop) head.push(`Stop $${stop}`);
  if (limit) head.push(`Limit $${limit}`);
  if (head.length === 0 && typeof data.type === "string") head.push(String(data.type).replace(/_/g, " "));

  let market = "";
  if (bid && ask) market = ` vs bid $${bid} / ask $${ask}`;
  else if (last) market = ` (last $${last})`;

  const parts: string[] = [];
  if (head.length > 0) parts.push(head.join(" ") + market);
  if (estimated) parts.push(`Estimated cost $${estimated}`);
  return parts.length > 0 ? parts.join(". ") : null;
}

export function parseBrokerReview(raw: unknown): BrokerReview {
  let root: unknown = raw;
  if (typeof raw === "string") {
    try {
      root = JSON.parse(raw);
    } catch {
      // Not JSON: keep it as a short summary so nothing is silently lost.
      return { alerts: [], disclosure: null, summary: raw.trim().slice(0, 300) || null };
    }
  }
  const rootRecord = asRecord(root);
  if (!rootRecord) return { alerts: [], disclosure: null, summary: null };

  // The useful payload sits under `data`; `guide` is intentionally ignored.
  const data = asRecord(rootRecord.data) ?? rootRecord;
  return {
    alerts: parseAlerts(data.order_checks),
    disclosure: typeof data.market_data_disclosure === "string" ? data.market_data_disclosure : null,
    summary: buildSummary(data),
  };
}
