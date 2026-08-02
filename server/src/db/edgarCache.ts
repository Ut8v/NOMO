import { getDb } from "./index.js";

/**
 * Persistent cache for SEC EDGAR responses, keyed by endpoint + identifier.
 * Filings change slowly, so a fresh cache row is served without any network
 * call; the per-endpoint TTL is applied here against fetched_at.
 */

interface CacheRow {
  body: string;
  fetched_at: string;
}

/** Returns the cached body if present and newer than ttlMs, else null. */
export function readEdgarCache(endpoint: string, identifier: string, ttlMs: number): string | null {
  const row = getDb()
    .prepare("SELECT body, fetched_at FROM edgar_cache WHERE endpoint = ? AND identifier = ?")
    .get(endpoint, identifier) as CacheRow | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (!Number.isFinite(age) || age > ttlMs) return null;
  return row.body;
}

export function writeEdgarCache(endpoint: string, identifier: string, body: string): void {
  getDb()
    .prepare(
      `INSERT INTO edgar_cache (endpoint, identifier, body, fetched_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (endpoint, identifier) DO UPDATE SET
         body = excluded.body,
         fetched_at = excluded.fetched_at`,
    )
    .run(endpoint, identifier, body);
}
