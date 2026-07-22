import type { OhlcvBar } from "@nomo/shared";

/**
 * Deterministic indicator math. Pure functions over closes or bars; the model
 * never computes these itself. Positions before an indicator has enough data
 * are null so series stay aligned with their bars.
 */

export function sma(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) {
      sum -= values[i - period]!;
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }
  return result;
}

export function ema(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;

  // Standard convention: seed with the SMA of the first window, then blend
  // with k = 2 / (period + 1).
  let seed = 0;
  for (let i = 0; i < period; i++) {
    seed += values[i]!;
  }
  let previous = seed / period;
  result[period - 1] = previous;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    previous = values[i]! * k + previous * (1 - k);
    result[i] = previous;
  }
  return result;
}

/**
 * Cumulative VWAP anchored at the start of the series. For intraday series
 * the series starts at the session window the chart requested.
 */
export function vwap(bars: OhlcvBar[]): (number | null)[] {
  const result: (number | null)[] = new Array(bars.length).fill(null);
  let cumulativePV = 0;
  let cumulativeVolume = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const typical = (b.high + b.low + b.close) / 3;
    cumulativePV += typical * b.volume;
    cumulativeVolume += b.volume;
    result[i] = cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : null;
  }
  return result;
}
