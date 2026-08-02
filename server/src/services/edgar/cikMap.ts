import { config } from "../../config.js";
import { EdgarError, TTL, fetchEdgarJson } from "./client.js";

/**
 * Resolves a ticker to its zero-padded 10-digit CIK, which the companyfacts and
 * submissions endpoints require. The ticker map is a single large JSON file
 * cached for a week; it changes rarely.
 */

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface CompanyId {
  /** Zero-padded 10-digit CIK, e.g. 0000320193. */
  cik: string;
  ticker: string;
  title: string;
}

export async function resolveCik(ticker: string): Promise<CompanyId> {
  const wanted = ticker.trim().toUpperCase();
  if (!wanted) throw new EdgarError("not_found", "A ticker is required.");

  const map = await fetchEdgarJson<Record<string, TickerEntry>>(
    config.secWwwBaseUrl,
    "/files/company_tickers.json",
    { endpoint: "tickers", identifier: "all", ttlMs: TTL.tickers },
  );

  for (const entry of Object.values(map)) {
    if (entry && entry.ticker === wanted) {
      return { cik: String(entry.cik_str).padStart(10, "0"), ticker: wanted, title: entry.title };
    }
  }
  throw new EdgarError("not_found", `No SEC filer found for ticker ${wanted}.`);
}
