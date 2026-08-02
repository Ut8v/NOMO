import { config } from "../../config.js";
import { readEdgarCache, readEdgarCacheStale, writeEdgarCache } from "../../db/edgarCache.js";

/**
 * The single HTTP path to SEC EDGAR. Every request carries the descriptive
 * User-Agent SEC asks for and is serialized behind a minimum interval, keeping
 * NOMO well under the 10 requests/second cap. Cache-first is the real strategy:
 * a fresh cache row skips the network entirely, and a stale row is served as a
 * fallback when SEC is unreachable.
 */

export type EdgarErrorCode = "not_found" | "rate_limited" | "upstream_error";

export class EdgarError extends Error {
  constructor(
    public readonly code: EdgarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EdgarError";
  }
}

// Per-endpoint cache TTLs from the spec.
export const TTL = {
  companyFacts: 24 * 60 * 60 * 1000,
  submissions: 24 * 60 * 60 * 1000,
  tickers: 7 * 24 * 60 * 60 * 1000,
  filing: 30 * 24 * 60 * 60 * 1000, // a filed document never changes
};

// ~6.6 req/s, comfortably under SEC's 10/s ceiling.
const MIN_INTERVAL_MS = 150;
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Serializes requests and spaces them by MIN_INTERVAL_MS. */
function schedule<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return run();
  });
  // Keep the chain alive even if one request rejects.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

interface CacheKey {
  endpoint: string;
  identifier: string;
  ttlMs: number;
}

/** Fetches a raw body (JSON or XML), cache-first, rate-limited, with a stale fallback. */
export async function fetchEdgarText(baseUrl: string, path: string, cache: CacheKey): Promise<string> {
  const fresh = readEdgarCache(cache.endpoint, cache.identifier, cache.ttlMs);
  if (fresh !== null) return fresh;

  let res: Response;
  try {
    res = await schedule(() =>
      fetch(`${baseUrl}${path}`, {
        headers: { "User-Agent": config.secUserAgent, Accept: "application/json, text/xml, */*" },
      }),
    );
  } catch {
    const stale = readEdgarCacheStale(cache.endpoint, cache.identifier);
    if (stale !== null) return stale;
    throw new EdgarError("upstream_error", "SEC EDGAR is unreachable right now. Try again shortly.");
  }

  if (res.status === 404) {
    throw new EdgarError("not_found", `SEC EDGAR has no data at ${path}.`);
  }
  if (!res.ok) {
    const stale = readEdgarCacheStale(cache.endpoint, cache.identifier);
    if (stale !== null) return stale;
    const code: EdgarErrorCode = res.status === 429 ? "rate_limited" : "upstream_error";
    throw new EdgarError(code, `SEC EDGAR request failed (${res.status}).`);
  }

  const body = await res.text();
  writeEdgarCache(cache.endpoint, cache.identifier, body);
  return body;
}

export async function fetchEdgarJson<T>(baseUrl: string, path: string, cache: CacheKey): Promise<T> {
  return JSON.parse(await fetchEdgarText(baseUrl, path, cache)) as T;
}
