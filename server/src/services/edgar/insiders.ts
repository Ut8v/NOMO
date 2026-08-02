import { XMLParser } from "fast-xml-parser";
import { config } from "../../config.js";
import { TTL, fetchEdgarText } from "./client.js";
import { resolveCik } from "./cikMap.js";
import { getSubmissions } from "./submissions.js";

/**
 * Insider transactions from SEC Form 4 filings. For each recent Form 4 we fetch
 * the ownership XML and parse the non-derivative transactions into plain buys
 * and sells with the insider's name, role, share count, and price.
 */

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

const DEFAULT_DAYS = 90;
const MAX_FILINGS = 25;
const MAX_TRADES = 100;

export interface InsiderTrade {
  insider: string;
  role: string;
  date: string;
  security: string;
  transactionCode: string;
  side: "buy" | "sell" | "other";
  shares: number | null;
  price: number | null;
  filingDate: string;
}

export interface InsiderTrades {
  ticker: string;
  cik: string;
  entityName: string;
  trades: InsiderTrade[];
}

function toArray<T>(x: T | T[] | undefined): T[] {
  return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
}

function text(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "object" && "value" in (node as Record<string, unknown>)) {
    return String((node as { value: unknown }).value ?? "");
  }
  return String(node);
}

function num(node: unknown): number | null {
  const n = Number(text(node));
  return Number.isFinite(n) ? n : null;
}

interface ParsedForm4 {
  insider: string;
  role: string;
  transactions: Array<Omit<InsiderTrade, "insider" | "role" | "filingDate">>;
}

/** Parses one Form 4 ownership XML document; returns null if not a Form 4. */
export function parseForm4(xml: string): ParsedForm4 | null {
  const doc = (parser.parse(xml) as { ownershipDocument?: Record<string, unknown> } | undefined)?.ownershipDocument;
  if (!doc) return null;

  const owner = (toArray(doc.reportingOwner)[0] ?? {}) as Record<string, Record<string, unknown>>;
  const insider = text(owner.reportingOwnerId?.rptOwnerName) || "Unknown";
  const rel = (owner.reportingOwnerRelationship ?? {}) as Record<string, unknown>;
  const roles: string[] = [];
  if (text(rel.isDirector) === "1") roles.push("Director");
  if (text(rel.isOfficer) === "1") roles.push(text(rel.officerTitle) || "Officer");
  if (text(rel.isTenPercentOwner) === "1") roles.push("10% owner");
  const role = roles.join(", ") || "Insider";

  const table = (doc.nonDerivativeTable ?? {}) as Record<string, unknown>;
  const transactions = toArray(table.nonDerivativeTransaction as unknown[]).map((raw) => {
    const t = raw as Record<string, Record<string, unknown>>;
    const amounts = (t.transactionAmounts ?? {}) as Record<string, unknown>;
    const acquiredDisposed = text(amounts.transactionAcquiredDisposedCode);
    const side: InsiderTrade["side"] = acquiredDisposed === "A" ? "buy" : acquiredDisposed === "D" ? "sell" : "other";
    return {
      date: text(t.transactionDate),
      security: text(t.securityTitle),
      transactionCode: text((t.transactionCoding as Record<string, unknown>)?.transactionCode),
      side,
      shares: num(amounts.transactionShares),
      price: num(amounts.transactionPricePerShare),
    };
  });

  return { insider, role, transactions };
}

export async function getInsiderTrades(ticker: string, opts: { days?: number } = {}): Promise<InsiderTrades> {
  const { cik, ticker: sym, title } = await resolveCik(ticker);
  const { entityName, filings } = await getSubmissions(cik, title);

  const days = opts.days && opts.days > 0 ? opts.days : DEFAULT_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const cikInt = String(Number(cik));

  const form4s = filings
    .filter((f) => (f.form === "4" || f.form === "4/A") && f.filingDate && new Date(f.filingDate).getTime() >= cutoff)
    .slice(0, MAX_FILINGS);

  const trades: InsiderTrade[] = [];
  for (const f of form4s) {
    // The submissions primaryDocument may point at an xsl-rendered variant; the
    // raw ownership XML sits in the same folder without that prefix.
    const rawDoc = f.primaryDocument.replace(/^xsl[^/]*\//, "");
    const accNoDashes = f.accessionNumber.replace(/-/g, "");
    const path = `/Archives/edgar/data/${cikInt}/${accNoDashes}/${rawDoc}`;
    let parsed: ParsedForm4 | null = null;
    try {
      const xml = await fetchEdgarText(config.secWwwBaseUrl, path, {
        endpoint: "form4",
        identifier: `${accNoDashes}/${rawDoc}`,
        ttlMs: TTL.filing,
      });
      parsed = parseForm4(xml);
    } catch {
      continue; // a single unreadable filing should not sink the whole result
    }
    if (!parsed) continue;
    for (const t of parsed.transactions) {
      trades.push({ insider: parsed.insider, role: parsed.role, filingDate: f.filingDate, ...t });
      if (trades.length >= MAX_TRADES) break;
    }
    if (trades.length >= MAX_TRADES) break;
  }

  trades.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { ticker: sym, cik, entityName, trades };
}
