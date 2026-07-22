import type { ChartOverlay, ChartSpec, ChartTimeframe, OhlcvBar } from "@nomo/shared";
import { ema, sma, vwap } from "../services/indicators.js";
import { getAggregates, getPreviousClose } from "../services/polygon.js";
import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";

const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

interface TimeframePlan {
  multiplier: number;
  timespan: "minute" | "hour" | "day" | "week";
  days: number;
}

/** Bar resolution per requested window, tuned to keep bar counts chartable. */
const TIMEFRAMES: Record<ChartTimeframe, TimeframePlan> = {
  "1D": { multiplier: 5, timespan: "minute", days: 4 },
  "1W": { multiplier: 30, timespan: "minute", days: 7 },
  "1M": { multiplier: 1, timespan: "hour", days: 31 },
  "3M": { multiplier: 1, timespan: "day", days: 92 },
  "6M": { multiplier: 1, timespan: "day", days: 183 },
  "1Y": { multiplier: 1, timespan: "day", days: 365 },
  "5Y": { multiplier: 1, timespan: "week", days: 1827 },
};

const TIMEFRAME_VALUES = Object.keys(TIMEFRAMES) as ChartTimeframe[];

function normalizeTicker(raw: unknown): string {
  const ticker = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) {
    throw new Error("ticker must be a stock symbol like AAPL.");
  }
  return ticker;
}

function normalizeTimeframe(raw: unknown): ChartTimeframe {
  if (typeof raw === "string" && (TIMEFRAME_VALUES as string[]).includes(raw)) {
    return raw as ChartTimeframe;
  }
  throw new Error(`timeframe must be one of: ${TIMEFRAME_VALUES.join(", ")}.`);
}

function isoDate(msEpoch: number): string {
  return new Date(msEpoch).toISOString().slice(0, 10);
}

// US sessions including extended hours (4:00 to 20:00 ET) cross UTC midnight
// during standard time, so session grouping must use exchange local dates.
const EASTERN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function easternDate(unixSeconds: number): string {
  return EASTERN_DATE.format(new Date(unixSeconds * 1000));
}

/** Keeps only bars from the same exchange local session as the latest bar. */
export function filterLatestSession(bars: OhlcvBar[]): OhlcvBar[] {
  const lastBar = bars[bars.length - 1];
  if (!lastBar) return bars;
  const session = easternDate(lastBar.time);
  return bars.filter((bar) => easternDate(bar.time) === session);
}

async function fetchBars(ticker: string, timeframe: ChartTimeframe): Promise<OhlcvBar[]> {
  const plan = TIMEFRAMES[timeframe];
  const now = Date.now();
  const from = isoDate(now - plan.days * 24 * 60 * 60 * 1000);
  const to = isoDate(now);
  const bars = await getAggregates(ticker, plan.multiplier, plan.timespan, from, to);
  // 1D uses a few calendar days of lookback to survive weekends and
  // holidays; keep only the most recent session's bars.
  if (timeframe === "1D") {
    return filterLatestSession(bars);
  }
  return bars;
}

interface IndicatorRequest {
  kind: "sma" | "ema" | "vwap";
  period?: number;
}

function parseIndicators(raw: unknown): IndicatorRequest[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("indicators must be an array of strings like sma_20, ema_50, vwap.");
  }
  const requests: IndicatorRequest[] = [];
  for (const entry of raw) {
    const text = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (text === "vwap") {
      requests.push({ kind: "vwap" });
      continue;
    }
    if (text === "volume") {
      // The volume pane is always drawn; accept the name for convenience.
      continue;
    }
    const match = /^(sma|ema)_?(\d{1,3})$/.exec(text);
    if (!match || Number(match[2]) < 1) {
      throw new Error(`Unknown indicator "${String(entry)}". Use sma_N, ema_N, or vwap.`);
    }
    requests.push({ kind: match[1] as "sma" | "ema", period: Number(match[2]) });
  }
  return requests;
}

function buildOverlays(bars: OhlcvBar[], requests: IndicatorRequest[]): ChartOverlay[] {
  const closes = bars.map((bar) => bar.close);
  return requests.map((request) => {
    const values =
      request.kind === "vwap"
        ? vwap(bars)
        : request.kind === "sma"
          ? sma(closes, request.period!)
          : ema(closes, request.period!);
    return {
      kind: request.kind,
      period: request.period,
      label: request.kind === "vwap" ? "VWAP" : `${request.kind.toUpperCase()} ${request.period}`,
      series: bars.map((bar, i) => ({ time: bar.time, value: values[i] ?? null })),
    };
  });
}

function summarizeBars(ticker: string, timeframe: ChartTimeframe, bars: OhlcvBar[]) {
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const high = Math.max(...bars.map((bar) => bar.high));
  const low = Math.min(...bars.map((bar) => bar.low));
  const changePct = ((last.close - first.open) / first.open) * 100;
  return {
    ticker,
    timeframe,
    barCount: bars.length,
    from: isoDate(first.time * 1000),
    to: isoDate(last.time * 1000),
    open: first.open,
    lastClose: last.close,
    high,
    low,
    changePct: Math.round(changePct * 100) / 100,
  };
}

export function registerMarketDataTools(): void {
  registerTool({
    name: "get_quote",
    tier: "market_data",
    description:
      "Get the most recent daily quote for a stock ticker (previous session OHLC, close, and volume). Data is end of day, not live.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
      },
      required: ["ticker"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const { ticker } = input as { ticker?: unknown };
      const quote = await getPreviousClose(normalizeTicker(ticker));
      return { forModel: quote };
    },
  });

  registerTool({
    name: "get_ohlcv",
    tier: "market_data",
    description:
      "Get OHLCV summary statistics and the most recent bars for a ticker over a timeframe. Use this to inspect price history without rendering a chart.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        timeframe: { type: "string", enum: TIMEFRAME_VALUES },
      },
      required: ["ticker", "timeframe"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const params = input as { ticker?: unknown; timeframe?: unknown };
      const ticker = normalizeTicker(params.ticker);
      const timeframe = normalizeTimeframe(params.timeframe);
      const bars = await fetchBars(ticker, timeframe);
      return {
        forModel: {
          ...summarizeBars(ticker, timeframe, bars),
          recentBars: bars.slice(-20).map((bar) => ({
            date: new Date(bar.time * 1000).toISOString(),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          })),
        },
      };
    },
  });

  registerTool({
    name: "render_chart",
    tier: "market_data",
    description:
      "Render an interactive candlestick chart of a ticker inline in the conversation, with optional indicator overlays (sma_N, ema_N, vwap). The user sees the full chart; you receive a summary. Prefer this whenever the user asks to see price action.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        timeframe: { type: "string", enum: TIMEFRAME_VALUES },
        indicators: {
          type: "array",
          items: { type: "string" },
          description: "Overlays such as sma_20, ema_50, vwap",
        },
      },
      required: ["ticker", "timeframe"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const params = input as { ticker?: unknown; timeframe?: unknown; indicators?: unknown };
      const ticker = normalizeTicker(params.ticker);
      const timeframe = normalizeTimeframe(params.timeframe);
      const requests = parseIndicators(params.indicators);
      const bars = await fetchBars(ticker, timeframe);
      const plan = TIMEFRAMES[timeframe];

      const spec: ChartSpec = {
        type: "chart",
        ticker,
        timeframe,
        intraday: plan.timespan === "minute" || plan.timespan === "hour",
        bars,
        overlays: buildOverlays(bars, requests),
        showVolume: true,
      };

      return {
        forModel: {
          rendered: true,
          note: "The chart is now displayed to the user.",
          ...summarizeBars(ticker, timeframe, bars),
          indicators: spec.overlays.map((overlay) => overlay.label),
        },
        chart: spec,
      };
    },
  });
}
