/** Types for the read-only local database dashboard. */

export interface TableSummary {
  name: string;
  rowCount: number;
}

export interface TablePage {
  name: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}
