/**
 * Trade journal performance types. All aggregate figures are computed
 * deterministically on the server; Claude only interprets them.
 */

export interface PerformanceRow {
  tag: string;
  trades: number;
  wins: number;
  losses: number;
  totalPl: number;
  avgPl: number;
  winRate: number;
}

export interface PerformanceReport {
  overall: PerformanceRow;
  byTag: PerformanceRow[];
}
