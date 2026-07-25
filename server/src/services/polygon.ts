import type { OhlcvBar } from "@nomo/shared";
import { config } from "../config.js";
import { getCredential } from "../db/credentials.js";
import { TtlCache } from "./cache.js";

export type PolygonErrorCode = "missing_api_key" | "invalid_api_key" | "rate_limited" | "not_found" | "upstream_error";

export class PolygonError extends Error {
  constructor(
    public readonly code: PolygonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PolygonError";
  }
}

export interface PreviousClose {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PolygonAggBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const barsCache = new TtlCache<OhlcvBar[]>();
const quoteCache = new TtlCache<PreviousClose>();

const INTRADAY_TTL_MS = 5 * 60 * 1000;
const DAILY_TTL_MS = 60 * 60 * 1000;
const QUOTE_TTL_MS = 5 * 60 * 1000;
// Empty results are cached too, so a bad ticker cannot burn through the
// free tier request budget on retries.
const NOT_FOUND_TTL_MS = 5 * 60 * 1000;

// After a 429, further requests are refused locally for a minute so
// retries cannot keep burning the free tier request budget.
let rateLimitedUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

async function polygonGet(path: string): Promise<unknown> {
  const apiKey = getCredential("polygon");
  if (!apiKey) {
    throw new PolygonError("missing_api_key", "No Polygon API key is stored. Run setup first.");
  }
  if (Date.now() < rateLimitedUntil) {
    throw new PolygonError(
      "rate_limited",
      "Polygon requests are paused for a minute after hitting the free tier rate limit. Try again shortly.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${config.polygonBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PolygonError("upstream_error", "Could not reach the Polygon API.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new PolygonError("invalid_api_key", "Polygon rejected the stored API key.");
  }
  if (res.status === 429) {
    rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    throw new PolygonError("rate_limited", "Polygon rate limit hit (5 requests per minute on the free tier). Try again in a minute.");
  }
  if (res.status === 404) {
    throw new PolygonError("not_found", "Polygon has no data for that request.");
  }
  if (!res.ok) {
    throw new PolygonError("upstream_error", `Polygon API returned status ${res.status}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new PolygonError("upstream_error", "Polygon returned an unreadable response.");
  }
}

export async function getAggregates(
  ticker: string,
  multiplier: number,
  timespan: "minute" | "hour" | "day" | "week",
  from: string,
  to: string,
): Promise<OhlcvBar[]> {
  const cacheKey = `${ticker}:${multiplier}:${timespan}:${from}:${to}`;
  const cached = barsCache.get(cacheKey);
  if (cached) {
    if (cached.length === 0) {
      throw new PolygonError("not_found", `Polygon returned no bars for ${ticker} in that range.`);
    }
    return cached;
  }

  const data = (await polygonGet(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000`,
  )) as { results?: PolygonAggBar[] };

  const bars: OhlcvBar[] = (data.results ?? []).map((bar) => ({
    time: Math.floor(bar.t / 1000),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));

  if (bars.length === 0) {
    barsCache.set(cacheKey, [], NOT_FOUND_TTL_MS);
    throw new PolygonError("not_found", `Polygon returned no bars for ${ticker} in that range.`);
  }

  const ttl = timespan === "minute" || timespan === "hour" ? INTRADAY_TTL_MS : DAILY_TTL_MS;
  barsCache.set(cacheKey, bars, ttl);
  return bars;
}

/** Free tier has no live quotes; the previous session close is the best available. */
export async function getPreviousClose(ticker: string): Promise<PreviousClose> {
  const cached = quoteCache.get(ticker);
  if (cached) return cached;

  const data = (await polygonGet(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true`,
  )) as { results?: PolygonAggBar[] };

  const bar = data.results?.[0];
  if (!bar) {
    throw new PolygonError("not_found", `Polygon has no previous close for ${ticker}.`);
  }

  const quote: PreviousClose = {
    ticker,
    date: new Date(bar.t).toISOString().slice(0, 10),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
  quoteCache.set(ticker, quote, QUOTE_TTL_MS);
  return quote;
}
