import { resolveCik } from "./cikMap.js";
import { filingUrl, getSubmissions } from "./submissions.js";

/**
 * Recent SEC filings for a ticker, filtered by form type and recency, with 8-K
 * items decoded into the material events they represent.
 */

// Common 8-K item codes. Anything present makes an 8-K a flagged material event.
const EIGHT_K_ITEMS: Record<string, string> = {
  "1.01": "Entry into a material agreement",
  "1.03": "Bankruptcy or receivership",
  "2.01": "Completion of an acquisition or disposition",
  "2.02": "Results of operations (earnings)",
  "2.03": "Creation of a material financial obligation",
  "3.01": "Delisting or listing-standard notice",
  "4.01": "Change in accountant",
  "4.02": "Non-reliance on prior financials (restatement)",
  "5.01": "Change in control",
  "5.02": "Departure or appointment of directors or officers",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Financial statements and exhibits",
};

const DEFAULT_DAYS = 90;
const MAX_RESULTS = 50;

export interface FilingView {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  url: string;
  /** Present for 8-K filings: the decoded material-event items. */
  items?: Array<{ code: string; label: string }>;
  material: boolean;
}

export interface RecentFilings {
  ticker: string;
  cik: string;
  entityName: string;
  filings: FilingView[];
}

function decodeItems(items: string): Array<{ code: string; label: string }> {
  return items
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => ({ code, label: EIGHT_K_ITEMS[code] ?? "Other item" }));
}

export async function getRecentFilings(
  ticker: string,
  opts: { forms?: string[]; days?: number } = {},
): Promise<RecentFilings> {
  const { cik, ticker: sym, title } = await resolveCik(ticker);
  const { entityName, filings } = await getSubmissions(cik, title);

  const days = opts.days && opts.days > 0 ? opts.days : DEFAULT_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const wantedForms = opts.forms?.map((f) => f.trim().toUpperCase()).filter(Boolean);

  const views: FilingView[] = [];
  for (const f of filings) {
    if (!f.filingDate || new Date(f.filingDate).getTime() < cutoff) continue;
    if (wantedForms && wantedForms.length > 0 && !wantedForms.some((w) => f.form.toUpperCase().startsWith(w))) {
      continue;
    }
    const isEightK = f.form.toUpperCase().startsWith("8-K");
    const items = isEightK && f.items ? decodeItems(f.items) : undefined;
    views.push({
      form: f.form,
      filingDate: f.filingDate,
      reportDate: f.reportDate,
      accessionNumber: f.accessionNumber,
      url: filingUrl(cik, f.accessionNumber, f.primaryDocument),
      ...(items && items.length > 0 ? { items } : {}),
      material: isEightK,
    });
    if (views.length >= MAX_RESULTS) break;
  }

  return { ticker: sym, cik, entityName, filings: views };
}
