import type { PendingOrderView, PositionView } from "@nomo/shared";
import { recordToolCall } from "../db/auditLog.js";
import { normalizeTicker, proposeClosePosition as gateProposeClose } from "./executionGate.js";
import { fetchEquityPositions, simulateEquityOrder } from "./robinhoodMcp.js";

/**
 * Portfolio reads and the close-position proposal for the portfolio view.
 * Closing a position here is a proposal path like every other: the position's
 * quantity is read from the broker (never from the client), the order is
 * simulated, and a pending_orders row is written for the user to confirm.
 * The broker is still reached solely through the unchanged confirmation gate.
 */

/** Thrown for request problems the route should report as 4xx, not 502. */
export class ClosePositionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function decimalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Maps the broker's positions payload to typed views; unusable entries are dropped. */
export function parsePositions(raw: unknown): PositionView[] {
  const positions = (raw as { positions?: unknown } | null)?.positions;
  if (!Array.isArray(positions)) return [];
  return positions.flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const symbol = typeof record.symbol === "string" ? record.symbol.trim().toUpperCase() : "";
    const quantity = decimalString(record.quantity);
    if (!symbol || !quantity) return [];
    const view: PositionView = {
      symbol,
      quantity,
      averageBuyPrice: decimalString(record.average_buy_price),
      marketValue: decimalString(record.market_value),
      side: record.side === "short" ? "short" : "long",
    };
    return [view];
  });
}

export async function listPositions(): Promise<PositionView[]> {
  return parsePositions(await fetchEquityPositions());
}

/**
 * Builds a gated sell proposal that closes the full position in a ticker.
 * Fails without writing anything when the position does not exist or the
 * mandatory pre-trade simulation fails.
 */
export async function proposeClosePosition(rawTicker: unknown): Promise<PendingOrderView> {
  let ticker: string;
  try {
    ticker = normalizeTicker(rawTicker);
  } catch (err) {
    throw new ClosePositionError(err instanceof Error ? err.message : "Invalid ticker.", 400);
  }

  const positions = await listPositions();
  const position = positions.find((p) => p.symbol === ticker && p.side === "long");
  if (!position) {
    throw new ClosePositionError(`No open long position in ${ticker}.`, 404);
  }
  const quantity = Number(position.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ClosePositionError(`The ${ticker} position quantity is not sellable.`, 409);
  }

  const warnings = await simulateEquityOrder(
    { ticker, side: "sell", quantity: position.quantity, orderType: "market" },
    "portfolio",
  );

  const order = gateProposeClose(
    {
      ticker,
      quantity,
      rationale: `User-initiated close of the full ${position.quantity} share ${ticker} position from the portfolio view.`,
    },
    JSON.stringify(warnings),
  );
  recordToolCall({
    toolName: "close_position",
    tier: "execution",
    params: { ticker, quantity: position.quantity },
    outcome: "proposed, awaiting confirmation",
    agent: "portfolio",
  });
  return order;
}
