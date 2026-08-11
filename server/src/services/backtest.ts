import type { OhlcvBar } from "@nomo/shared";
import { getAggregates } from "./polygon.js";
import { rsi, sma } from "./indicators.js";

/**
 * Deterministic long-only backtester. The model picks a rule and its
 * parameters; everything numeric (signals, equity curve, and metrics) is
 * computed here in TypeScript, never by the model. Signals act at a bar's close
 * and the position is held into the next bar, so there is no lookahead.
 */

export type StrategyName = "buy_and_hold" | "sma_crossover" | "price_vs_sma" | "rsi_reversion";

export interface StrategyParams {
  fast?: number;
  slow?: number;
  period?: number;
  oversold?: number;
  overbought?: number;
}

/** Builds a 0/1 (flat/long) position series from a named rule and its parameters. */
export function buildPositions(
  bars: OhlcvBar[],
  strategy: StrategyName,
  params: StrategyParams,
): { positions: number[]; label: string } {
  const closes = bars.map((b) => b.close);
  const n = bars.length;

  if (strategy === "buy_and_hold") {
    return { positions: new Array(n).fill(1), label: "Buy and hold" };
  }

  if (strategy === "sma_crossover") {
    const fast = Math.max(1, Math.floor(params.fast ?? 20));
    const slow = Math.max(fast + 1, Math.floor(params.slow ?? 50));
    const f = sma(closes, fast);
    const s = sma(closes, slow);
    const positions = closes.map((_, i) => (f[i] !== null && s[i] !== null && f[i]! > s[i]! ? 1 : 0));
    return { positions, label: `SMA crossover (${fast} over ${slow}): long while fast SMA is above slow SMA` };
  }

  if (strategy === "price_vs_sma") {
    const period = Math.max(1, Math.floor(params.period ?? 50));
    const m = sma(closes, period);
    const positions = closes.map((c, i) => (m[i] !== null && c > m[i]! ? 1 : 0));
    return { positions, label: `Price vs SMA (${period}): long while price is above the ${period}-period SMA` };
  }

  // rsi_reversion: buy oversold, exit overbought, hold in between (stateful).
  const period = Math.max(2, Math.floor(params.period ?? 14));
  const oversold = params.oversold ?? 30;
  const overbought = params.overbought ?? 70;
  const r = rsi(closes, period);
  const positions: number[] = new Array(n).fill(0);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const v = r[i];
    if (v === null || v === undefined) {
      positions[i] = 0;
      continue;
    }
    if (pos === 0 && v < oversold) pos = 1;
    else if (pos === 1 && v > overbought) pos = 0;
    positions[i] = pos;
  }
  return {
    positions,
    label: `RSI reversion (period ${period}): buy below ${oversold}, exit above ${overbought}`,
  };
}

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

const STRATEGIES: readonly StrategyName[] = ["buy_and_hold", "sma_crossover", "price_vs_sma", "rsi_reversion"];
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DEFAULT_LOOKBACK_DAYS = 365;
const MAX_LOOKBACK_DAYS = 1825; // ~5 years of daily bars

export interface BacktestResult extends BacktestMetrics {
  ticker: string;
  strategy: StrategyName;
  description: string;
  fromDate: string;
  toDate: string;
}

function isoDate(msEpoch: number): string {
  return new Date(msEpoch).toISOString().slice(0, 10);
}

/**
 * Runs a named strategy over a ticker's daily history and returns the metrics.
 * The bars come from Polygon; the model chooses the rule and parameters but
 * never the numbers.
 */
export async function runBacktest(
  ticker: string,
  opts: { strategy: StrategyName; params?: StrategyParams; lookbackDays?: number },
): Promise<BacktestResult> {
  const sym = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(sym)) throw new Error("ticker must be a stock symbol like AAPL.");
  if (!STRATEGIES.includes(opts.strategy)) {
    throw new Error(`strategy must be one of: ${STRATEGIES.join(", ")}.`);
  }
  const days = Math.min(Math.max(30, Math.floor(opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS)), MAX_LOOKBACK_DAYS);
  const now = Date.now();
  const bars = await getAggregates(sym, 1, "day", isoDate(now - days * 24 * 60 * 60 * 1000), isoDate(now));
  if (bars.length < 2) throw new Error(`Not enough price history for ${sym} to backtest.`);

  const { positions, label } = buildPositions(bars, opts.strategy, opts.params ?? {});
  const metrics = simulate(bars, positions);
  return {
    ticker: sym,
    strategy: opts.strategy,
    description: label,
    fromDate: isoDate(bars[0]!.time * 1000),
    toDate: isoDate(bars[bars.length - 1]!.time * 1000),
    ...metrics,
  };
}
