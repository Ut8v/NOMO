import { getCompanyFacts } from "../services/edgar/companyFacts.js";
import { getRecentFilings } from "../services/edgar/filings.js";
import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";

function ticker(input: unknown): string {
  const raw = (input as { ticker?: unknown } | undefined)?.ticker;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("ticker is required, e.g. AAPL.");
  return value;
}

/**
 * SEC EDGAR tools. All read-only market_data tier, backed by the cached EDGAR
 * client. Numbers are computed deterministically in TypeScript; the model only
 * interprets them.
 */
export function registerEdgarTools(): void {
  registerTool({
    name: "get_company_facts",
    tier: "market_data",
    description:
      "Get structured financials for a company from SEC filings (XBRL): annual revenue, net income, gross profit, assets, liabilities, and equity, plus revenue growth, margins, and leverage ratios computed from the source data. Use to cross-check fundamentals against the primary SEC data. These figures are computed for you; interpret them, do not recompute.",
    inputSchema: {
      type: "object",
      properties: { ticker: { type: "string", description: "Stock symbol, e.g. AAPL" } },
      required: ["ticker"],
    },
    execute: async (input): Promise<ToolExecutionResult> => ({ forModel: await getCompanyFacts(ticker(input)) }),
  });

  registerTool({
    name: "get_recent_filings",
    tier: "market_data",
    description:
      "List a company's recent SEC filings, optionally filtered by form type (e.g. 10-K, 10-Q, 8-K, 4) and a lookback window in days. 8-K filings are flagged as material events with their decoded items (earnings, executive changes, agreements, and so on). Use to spot recent catalysts and disclosures.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        forms: { type: "array", items: { type: "string" }, description: "Optional form types to include, e.g. [\"8-K\", \"10-Q\"]" },
        days: { type: "number", description: "Lookback window in days (default 90)" },
      },
      required: ["ticker"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const raw = (input ?? {}) as { forms?: unknown; days?: unknown };
      const forms = Array.isArray(raw.forms) ? raw.forms.filter((f): f is string => typeof f === "string") : undefined;
      const days = typeof raw.days === "number" ? raw.days : undefined;
      return { forModel: await getRecentFilings(ticker(input), { forms, days }) };
    },
  });
}
