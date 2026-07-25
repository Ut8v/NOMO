import type { PerformanceReport, PerformanceRow } from "@nomo/shared";

/**
 * Deterministic trade journal math. These are pure functions over recorded
 * outcomes; Claude never computes these figures, it only interprets them.
 */

export interface OutcomeInput {
  tags: string[];
  realizedPl: number;
}

const TAG_PATTERN = /#([a-z0-9_]+)/gi;

/** Extracts hashtag-style tags from a rationale. Falls back to "untagged". */
export function extractTags(rationale: string): string[] {
  const seen = new Set<string>();
  for (const match of rationale.matchAll(TAG_PATTERN)) {
    seen.add(match[1]!.toLowerCase());
  }
  return seen.size > 0 ? [...seen] : ["untagged"];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function aggregate(tag: string, outcomes: OutcomeInput[]): PerformanceRow {
  let wins = 0;
  let losses = 0;
  let totalPl = 0;
  for (const outcome of outcomes) {
    totalPl += outcome.realizedPl;
    if (outcome.realizedPl > 0) wins += 1;
    else if (outcome.realizedPl < 0) losses += 1;
  }
  const trades = outcomes.length;
  return {
    tag,
    trades,
    wins,
    losses,
    totalPl: round(totalPl, 2),
    avgPl: trades > 0 ? round(totalPl / trades, 2) : 0,
    winRate: trades > 0 ? round(wins / trades, 4) : 0,
  };
}

export function computePerformance(outcomes: OutcomeInput[]): PerformanceReport {
  const byTagMap = new Map<string, OutcomeInput[]>();
  for (const outcome of outcomes) {
    for (const tag of outcome.tags) {
      const bucket = byTagMap.get(tag) ?? [];
      bucket.push(outcome);
      byTagMap.set(tag, bucket);
    }
  }

  const byTag = [...byTagMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, tagOutcomes]) => aggregate(tag, tagOutcomes));

  return {
    overall: aggregate("overall", outcomes),
    byTag,
  };
}
