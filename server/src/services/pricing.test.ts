import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCostUsd, isPricedModel } from "./pricing.js";

test("computes cost from input and output tokens at list prices", () => {
  // sonnet-5: $3/1M input, $15/1M output.
  const cost = estimateCostUsd("claude-sonnet-5", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  assert.equal(cost, 18);
});

test("cache reads and writes bill at their multipliers", () => {
  // opus-5: $5/1M input. 1M cache reads = 0.1x = $0.5; 1M cache writes = 1.25x = $6.25.
  const cost = estimateCostUsd("claude-opus-5", {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 6.75) < 1e-9);
});

test("unknown model costs nothing and is not priced", () => {
  assert.equal(isPricedModel("made-up-model"), false);
  assert.equal(estimateCostUsd("made-up-model", { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0 }), 0);
});

test("small usage yields a small positive cost", () => {
  const cost = estimateCostUsd("claude-sonnet-5", {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  // 1200*3 + 300*15 = 3600 + 4500 = 8100 / 1e6 = 0.0081
  assert.ok(Math.abs(cost - 0.0081) < 1e-9);
});
