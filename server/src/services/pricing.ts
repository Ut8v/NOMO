/**
 * Anthropic API list prices, USD per million tokens. Used to estimate the
 * cost of chat usage for display. These are standard first-party rates; any
 * promotional discount is not reflected, so displayed cost is an estimate.
 */

interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// Cache reads bill at ~0.1x input; cache writes at ~1.25x (5 minute TTL).
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function isPricedModel(model: string): boolean {
  return model in PRICES;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const billedInput =
    usage.inputTokens +
    usage.cacheReadTokens * CACHE_READ_MULTIPLIER +
    usage.cacheCreationTokens * CACHE_WRITE_MULTIPLIER;
  const cost = (billedInput * price.input + usage.outputTokens * price.output) / 1_000_000;
  return cost;
}
