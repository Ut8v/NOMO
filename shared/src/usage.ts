/**
 * Anthropic API usage totals, shared between server and frontend. Cost is an
 * estimate from list prices.
 */
export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}
