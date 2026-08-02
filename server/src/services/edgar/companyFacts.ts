import { config } from "../../config.js";
import { TTL, fetchEdgarJson } from "./client.js";
import { resolveCik } from "./cikMap.js";

/**
 * Structured XBRL financials from SEC companyfacts, with growth, margin, and
 * leverage ratios computed here in TypeScript. Per the project rule, the LLM
 * never computes a growth rate from a filing; it only interprets these numbers.
 */

interface FactUnit {
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  val?: number;
}
interface CompanyFactsResponse {
  cik?: number;
  entityName?: string;
  facts?: { "us-gaap"?: Record<string, { units?: { USD?: FactUnit[] } }> };
}

// Concept fallbacks: newer filers report revenue under the contract-revenue tag.
const CONCEPTS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  netIncome: ["NetIncomeLoss"],
  grossProfit: ["GrossProfit"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
};

const MAX_YEARS = 5;

/** Annual (10-K, full-year) values by fiscal year, using the first concept that has data. */
function annualByYear(facts: CompanyFactsResponse, concepts: string[]): Map<number, number> {
  const gaap = facts.facts?.["us-gaap"] ?? {};
  for (const concept of concepts) {
    const units = gaap[concept]?.units?.USD;
    if (!Array.isArray(units)) continue;
    const byYear = new Map<number, { val: number; filed: string }>();
    for (const u of units) {
      if (u.fp !== "FY" || typeof u.form !== "string" || !u.form.startsWith("10-K")) continue;
      if (typeof u.fy !== "number" || typeof u.val !== "number") continue;
      const prev = byYear.get(u.fy);
      // A later filing (restatement) wins for the same fiscal year.
      if (!prev || (u.filed ?? "") > prev.filed) byYear.set(u.fy, { val: u.val, filed: u.filed ?? "" });
    }
    if (byYear.size > 0) return new Map([...byYear].map(([fy, v]) => [fy, v.val]));
  }
  return new Map();
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return round(((to - from) / Math.abs(from)) * 100);
}

export interface CompanyFacts {
  ticker: string;
  cik: string;
  entityName: string;
  currency: "USD";
  fiscalYears: number[];
  series: {
    revenue: (number | null)[];
    netIncome: (number | null)[];
    grossProfit: (number | null)[];
    assets: (number | null)[];
    liabilities: (number | null)[];
    equity: (number | null)[];
  };
  metrics: {
    latestFiscalYear: number | null;
    revenueGrowthYoYPct: number | null;
    netMarginPct: number | null;
    netMarginTrendPct: (number | null)[];
    grossMarginPct: number | null;
    debtToEquity: number | null;
    liabilitiesToAssets: number | null;
  };
}

export async function getCompanyFacts(ticker: string): Promise<CompanyFacts> {
  const { cik, ticker: sym, title } = await resolveCik(ticker);
  const facts = await fetchEdgarJson<CompanyFactsResponse>(
    config.secDataBaseUrl,
    `/api/xbrl/companyfacts/CIK${cik}.json`,
    { endpoint: "companyfacts", identifier: cik, ttlMs: TTL.companyFacts },
  );

  const maps = {
    revenue: annualByYear(facts, CONCEPTS.revenue),
    netIncome: annualByYear(facts, CONCEPTS.netIncome),
    grossProfit: annualByYear(facts, CONCEPTS.grossProfit),
    assets: annualByYear(facts, CONCEPTS.assets),
    liabilities: annualByYear(facts, CONCEPTS.liabilities),
    equity: annualByYear(facts, CONCEPTS.equity),
  };

  // Fiscal years come from the union across series so a missing revenue year
  // does not drop balance-sheet data; take the most recent MAX_YEARS.
  const years = [...new Set(Object.values(maps).flatMap((m) => [...m.keys()]))]
    .sort((a, b) => a - b)
    .slice(-MAX_YEARS);

  const at = (m: Map<number, number>, fy: number) => (m.has(fy) ? m.get(fy)! : null);
  const series = {
    revenue: years.map((fy) => at(maps.revenue, fy)),
    netIncome: years.map((fy) => at(maps.netIncome, fy)),
    grossProfit: years.map((fy) => at(maps.grossProfit, fy)),
    assets: years.map((fy) => at(maps.assets, fy)),
    liabilities: years.map((fy) => at(maps.liabilities, fy)),
    equity: years.map((fy) => at(maps.equity, fy)),
  };

  const latestFy = years.length > 0 ? years[years.length - 1]! : null;
  const prevFy = years.length > 1 ? years[years.length - 2]! : null;

  const rev = latestFy !== null ? at(maps.revenue, latestFy) : null;
  const prevRev = prevFy !== null ? at(maps.revenue, prevFy) : null;
  const netIncome = latestFy !== null ? at(maps.netIncome, latestFy) : null;
  const gross = latestFy !== null ? at(maps.grossProfit, latestFy) : null;
  const liabilities = latestFy !== null ? at(maps.liabilities, latestFy) : null;
  const equity = latestFy !== null ? at(maps.equity, latestFy) : null;
  const assets = latestFy !== null ? at(maps.assets, latestFy) : null;

  const netMarginTrendPct = years.map((fy) => {
    const r = at(maps.revenue, fy);
    const n = at(maps.netIncome, fy);
    return r && n !== null && r !== 0 ? round((n / r) * 100) : null;
  });

  return {
    ticker: sym,
    cik,
    entityName: facts.entityName ?? title,
    currency: "USD",
    fiscalYears: years,
    series,
    metrics: {
      latestFiscalYear: latestFy,
      revenueGrowthYoYPct: prevRev !== null && rev !== null ? pctChange(prevRev, rev) : null,
      netMarginPct: rev && netIncome !== null && rev !== 0 ? round((netIncome / rev) * 100) : null,
      netMarginTrendPct,
      grossMarginPct: rev && gross !== null && rev !== 0 ? round((gross / rev) * 100) : null,
      debtToEquity: liabilities !== null && equity && equity !== 0 ? round(liabilities / equity) : null,
      liabilitiesToAssets: liabilities !== null && assets && assets !== 0 ? round(liabilities / assets) : null,
    },
  };
}
