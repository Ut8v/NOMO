import assert from "node:assert/strict";
import { test } from "node:test";
import type { OhlcvBar } from "@nomo/shared";
import { ema, sma, vwap } from "./indicators.js";

function bar(time: number, price: number, volume: number): OhlcvBar {
  return { time, open: price, high: price, low: price, close: price, volume };
}

test("sma returns null until the window fills, then rolling means", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("sma with period 1 is the identity", () => {
  assert.deepEqual(sma([3, 1, 4], 1), [3, 1, 4]);
});

test("sma with period longer than the series is all null", () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test("sma of an empty series is empty", () => {
  assert.deepEqual(sma([], 3), []);
});

test("sma handles floating point windows without drift", () => {
  const result = sma([0.1, 0.2, 0.3, 0.4], 2);
  assert.equal(result[0], null);
  assert.ok(Math.abs((result[1] as number) - 0.15) < 1e-12);
  assert.ok(Math.abs((result[2] as number) - 0.25) < 1e-12);
  assert.ok(Math.abs((result[3] as number) - 0.35) < 1e-12);
});

test("ema seeds with the sma of the first window", () => {
  // Seed at index 2 is (2+4+6)/3 = 4. With k = 0.5:
  // index 3: 8*0.5 + 4*0.5 = 6, index 4: 10*0.5 + 6*0.5 = 8.
  assert.deepEqual(ema([2, 4, 6, 8, 10], 3), [null, null, 4, 6, 8]);
});

test("ema with period longer than the series is all null", () => {
  assert.deepEqual(ema([1, 2, 3], 4), [null, null, null]);
});

test("ema of a constant series is constant after the seed", () => {
  assert.deepEqual(ema([5, 5, 5, 5], 2), [null, 5, 5, 5]);
});

test("vwap accumulates typical price weighted by volume", () => {
  const bars = [bar(1, 10, 100), bar(2, 20, 300)];
  // Cumulative: 10*100 / 100 = 10, then (1000 + 6000) / 400 = 17.5.
  assert.deepEqual(vwap(bars), [10, 17.5]);
});

test("vwap uses the typical price, not the close", () => {
  const bars: OhlcvBar[] = [
    { time: 1, open: 10, high: 12, low: 8, close: 11, volume: 50 },
  ];
  // Typical price is (12 + 8 + 11) / 3, allowing float rounding from the
  // cumulative multiply and divide.
  const [value] = vwap(bars);
  assert.ok(Math.abs((value as number) - (12 + 8 + 11) / 3) < 1e-9);
});

test("vwap is null while cumulative volume is zero", () => {
  const bars = [bar(1, 10, 0), bar(2, 20, 100)];
  assert.equal(vwap(bars)[0], null);
  assert.equal(vwap(bars)[1], 20);
});

test("vwap of an empty series is empty", () => {
  assert.deepEqual(vwap([]), []);
});
