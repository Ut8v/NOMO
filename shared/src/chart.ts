/**
 * Chart spec produced by the render_chart tool and rendered by the frontend.
 * The numbers are computed deterministically on the server; the model only
 * chooses what to request.
 */

export interface OhlcvBar {
  /** Unix timestamp in seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ChartTimeframe = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y";

export type OverlayKind = "sma" | "ema" | "vwap";

export interface OverlayPoint {
  time: number;
  value: number | null;
}

export interface ChartOverlay {
  kind: OverlayKind;
  /** Present for sma and ema. */
  period?: number;
  /** Display label, e.g. "EMA 20". */
  label: string;
  series: OverlayPoint[];
}

export interface ChartSpec {
  type: "chart";
  ticker: string;
  timeframe: ChartTimeframe;
  /** True when bars are finer than one day, so times matter in the axis. */
  intraday: boolean;
  bars: OhlcvBar[];
  overlays: ChartOverlay[];
  showVolume: boolean;
}
