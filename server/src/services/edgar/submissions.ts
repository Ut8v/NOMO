import { config } from "../../config.js";
import { TTL, fetchEdgarJson } from "./client.js";

/**
 * Shared access to a company's SEC submissions feed (the list of every recent
 * filing). Both the filings tool and the insider-trades tool read from here, so
 * the fetch and the parallel-array shape live in one place.
 */

interface RecentArrays {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  form?: string[];
  items?: string[];
  primaryDocument?: string[];
}
interface SubmissionsResponse {
  cik?: number;
  name?: string;
  filings?: { recent?: RecentArrays };
}

export interface RawFiling {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  items: string;
}

export interface Submissions {
  cik: string;
  entityName: string;
  filings: RawFiling[];
}

/** Fetches submissions and zips the parallel recent-filing arrays into rows. */
export async function getSubmissions(cik: string, entityName: string): Promise<Submissions> {
  const data = await fetchEdgarJson<SubmissionsResponse>(
    config.secDataBaseUrl,
    `/submissions/CIK${cik}.json`,
    { endpoint: "submissions", identifier: cik, ttlMs: TTL.submissions },
  );
  const recent = data.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const filings: RawFiling[] = forms.map((form, i) => ({
    form,
    filingDate: recent.filingDate?.[i] ?? "",
    reportDate: recent.reportDate?.[i] ?? "",
    accessionNumber: recent.accessionNumber?.[i] ?? "",
    primaryDocument: recent.primaryDocument?.[i] ?? "",
    items: recent.items?.[i] ?? "",
  }));
  return { cik, entityName: data.name ?? entityName, filings };
}

/** Builds the public archive URL for a filing's primary document. */
export function filingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const accNoDashes = accessionNumber.replace(/-/g, "");
  const cikInt = String(Number(cik));
  return `${config.secWwwBaseUrl}/Archives/edgar/data/${cikInt}/${accNoDashes}/${primaryDocument}`;
}
