import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFindings } from "@nomo/shared";
import { AGENT_CLUSTERS, clusterAllows } from "./clusters.js";

const EXECUTION_TOOLS = [
  "place_equity_order",
  "cancel_equity_order",
  "place_option_order",
  "cancel_option_order",
];

test("no cluster exposes any execution tool", () => {
  for (const [cluster, names] of Object.entries(AGENT_CLUSTERS)) {
    for (const execTool of EXECUTION_TOOLS) {
      assert.ok(
        !names.includes(execTool),
        `cluster ${cluster} must not contain ${execTool}`,
      );
      assert.equal(clusterAllows(cluster as keyof typeof AGENT_CLUSTERS, execTool), false);
    }
  }
});

test("synthesis cluster is limited to tradability and simulation reads", () => {
  assert.deepEqual(AGENT_CLUSTERS.synthesis, ["get_equity_tradability", "review_equity_order"]);
});

test("parseFindings accepts a well formed object", () => {
  const result = parseFindings({
    ticker: "aapl",
    signals: [
      { name: "RSI(14)", value: 28.4, direction: "bullish", confidence: 0.6 },
      { name: "trend", value: "below 50 EMA", direction: "bearish", confidence: 0.5 },
    ],
    sources: ["get_equity_technical_indicators", ""],
  });
  assert.ok(result.ok);
  assert.equal(result.findings.ticker, "AAPL");
  assert.equal(result.findings.signals.length, 2);
  assert.equal(result.findings.signals[0]?.value, "28.4");
  assert.deepEqual(result.findings.sources, ["get_equity_technical_indicators"]);
});

test("parseFindings rejects bad direction, confidence, and shape", () => {
  assert.equal(parseFindings(null).ok, false);
  assert.equal(parseFindings({ ticker: "AAPL", signals: "no" }).ok, false);
  assert.equal(
    parseFindings({ ticker: "AAPL", signals: [{ name: "x", value: "1", direction: "up", confidence: 0.5 }] }).ok,
    false,
  );
  assert.equal(
    parseFindings({ ticker: "AAPL", signals: [{ name: "x", value: "1", direction: "bullish", confidence: 2 }] }).ok,
    false,
  );
  assert.equal(parseFindings({ ticker: "", signals: [] }).ok, false);
});

test("parseFindings allows empty signals for a specialist that found nothing", () => {
  const result = parseFindings({ ticker: "MSFT", signals: [], sources: [] });
  assert.ok(result.ok);
  assert.equal(result.findings.signals.length, 0);
});
