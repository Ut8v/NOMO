import type { UsageTotals } from "@nomo/shared";
import { getDb } from "./index.js";

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export function recordUsage(usage: UsageRecord): void {
  getDb()
    .prepare(
      `INSERT INTO usage_events (model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.costUsd,
    );
}

export function getUsageTotals(): UsageTotals {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS cost,
         COALESCE(SUM(input_tokens), 0) AS input,
         COALESCE(SUM(output_tokens), 0) AS output
       FROM usage_events`,
    )
    .get() as { cost: number; input: number; output: number };
  return { costUsd: row.cost, inputTokens: row.input, outputTokens: row.output };
}
