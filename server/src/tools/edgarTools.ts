import { getCompanyFacts } from "../services/edgar/companyFacts.js";
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
}
