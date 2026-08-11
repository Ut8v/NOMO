import assert from "node:assert/strict";
import { test } from "node:test";
import type { OhlcvBar } from "@nomo/shared";
import { rsi } from "../../src/services/indicators.js";
import { buildPositions, simulate } from "../../src/services/backtest.js";

function bars(closes: number[]): OhlcvBar[] {
  return closes.map((c, i) => ({ time: i * 86400, open: c, high: c, low: c, close: c, volume: 1 }));
}

test("buy-and-hold return equals the raw price return", () => {
  const b = bars([100, 110, 121]); // +10% each step
  const m = simulate(b, [1, 1, 1]);
  assert.equal(m.strategyReturnPct, 21);
  assert.equal(m.buyHoldReturnPct, 21);
  assert.equal(m.trades, 1);
  assert.equal(m.winRatePct, 100);
  assert.equal(m.finalPosition, "long");
});

test("a flat-then-long position only earns while long", () => {
  const b = bars([100, 110, 121]);
  const m = simulate(b, [0, 1, 0]); // enter at 110, exit at 121
  assert.equal(m.strategyReturnPct, 10);
  assert.equal(m.trades, 1);
  assert.equal(m.avgTradeReturnPct, 10);
  assert.equal(m.finalPosition, "flat");
});

test("max drawdown is measured on the equity curve", () => {
  const b = bars([100, 80, 120]);
  const m = simulate(b, [1, 1, 1]);
  assert.equal(m.strategyReturnPct, 20);
  assert.equal(m.maxDrawdownPct, -20);
});

test("price_vs_sma goes long only when price is above its SMA", () => {
  const { positions } = buildPositions(bars([1, 2, 3, 2, 1]), "price_vs_sma", { period: 2 });
  assert.deepEqual(positions, [0, 1, 1, 0, 0]);
});

test("sma_crossover goes long while the fast SMA leads the slow SMA", () => {
  const { positions } = buildPositions(bars([1, 2, 3, 2, 1]), "sma_crossover", { fast: 1, slow: 2 });
  assert.deepEqual(positions, [0, 1, 1, 0, 0]);
});

test("buy_and_hold is long for the whole window", () => {
  const { positions } = buildPositions(bars([5, 6, 7]), "buy_and_hold", {});
  assert.deepEqual(positions, [1, 1, 1]);
});

test("rsi is 100 on a pure uptrend and 0 on a pure downtrend", () => {
  const up = rsi([1, 2, 3, 4, 5, 6], 3);
  assert.equal(up[0], null);
  assert.equal(up[2], null);
  assert.equal(up[5], 100);
  const down = rsi([6, 5, 4, 3, 2, 1], 3);
  assert.equal(down[5], 0);
});

test("rsi_reversion buys oversold and exits overbought", () => {
  // Falls hard (RSI low), then rises hard (RSI high): enter near the bottom,
  // hold up, then exit once overbought.
  const closes = [100, 90, 80, 70, 60, 66, 73, 80, 88, 97];
  const { positions } = buildPositions(bars(closes), "rsi_reversion", { period: 3, oversold: 30, overbought: 70 });
  // Some bar in the decline is long, and the last (very overbought) bar is flat.
  assert.ok(positions.includes(1), "enters at some point");
  assert.equal(positions[positions.length - 1], 0, "exits once overbought");
});
