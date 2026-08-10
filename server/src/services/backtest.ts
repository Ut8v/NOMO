import type { OhlcvBar } from "@nomo/shared";

/**
 * Deterministic long-only backtester. The model picks a rule and its
 * parameters; everything numeric (signals, equity curve, and metrics) is
 * computed here in TypeScript, never by the model. Signals act at a bar's close
 * and the position is held into the next bar, so there is no lookahead.
 */

export interface BacktestMetrics {
  bars: number;
  strategyReturnPct: number;
  buyHoldReturnPct: number;
  trades: number;
  winRatePct: number | null;
  avgTradeReturnPct: number | null;
  maxDrawdownPct: number;
  finalPosition: "long" | "flat";
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Runs a 0/1 (flat/long) position series over the bars. A position of 1 at bar
 * i earns the close-to-close return from bar i to bar i+1.
 */
export function simulate(bars: OhlcvBar[], positions: number[]): BacktestMetrics {
  const n = bars.length;
  const flat: BacktestMetrics = {
    bars: n,
    strategyReturnPct: 0,
    buyHoldReturnPct: 0,
    trades: 0,
    winRatePct: null,
    avgTradeReturnPct: null,
    maxDrawdownPct: 0,
    finalPosition: "flat",
  };
  if (n < 2) return flat;

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (let i = 0; i < n - 1; i++) {
    const ret = bars[i + 1]!.close / bars[i]!.close - 1;
    if (positions[i] === 1) equity *= 1 + ret;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Round-trip trades: enter at the close where the position turns long, exit
  // at the close where it turns flat; an open position marks to the last close.
  const tradeReturns: number[] = [];
  let inTrade = false;
  let entryClose = 0;
  for (let i = 0; i < n; i++) {
    if (positions[i] === 1 && !inTrade) {
      inTrade = true;
      entryClose = bars[i]!.close;
    } else if (positions[i] !== 1 && inTrade) {
      inTrade = false;
      tradeReturns.push(bars[i]!.close / entryClose - 1);
    }
  }
  if (inTrade) tradeReturns.push(bars[n - 1]!.close / entryClose - 1);

  const wins = tradeReturns.filter((r) => r > 0).length;
  const avgTrade = tradeReturns.length > 0 ? tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length : null;

  return {
    bars: n,
    strategyReturnPct: round((equity - 1) * 100),
    buyHoldReturnPct: round((bars[n - 1]!.close / bars[0]!.close - 1) * 100),
    trades: tradeReturns.length,
    winRatePct: tradeReturns.length > 0 ? round((wins / tradeReturns.length) * 100) : null,
    avgTradeReturnPct: avgTrade !== null ? round(avgTrade * 100) : null,
    maxDrawdownPct: round(maxDrawdown * 100),
    finalPosition: positions[n - 1] === 1 ? "long" : "flat",
  };
}
