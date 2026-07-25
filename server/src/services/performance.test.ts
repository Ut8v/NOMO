import assert from "node:assert/strict";
import { test } from "node:test";
import { computePerformance, extractTags } from "./performance.js";

test("extractTags pulls hashtags, lowercased and deduped", () => {
  assert.deepEqual(extractTags("Buying the #Breakout on #momentum, classic #breakout"), ["breakout", "momentum"]);
});

test("extractTags falls back to untagged", () => {
  assert.deepEqual(extractTags("no tags here"), ["untagged"]);
});

test("extractTags ignores a bare hash", () => {
  assert.deepEqual(extractTags("cost was # high"), ["untagged"]);
});

test("computePerformance aggregates overall wins, losses, and totals", () => {
  const report = computePerformance([
    { tags: ["momentum"], realizedPl: 100 },
    { tags: ["momentum"], realizedPl: -40 },
    { tags: ["value"], realizedPl: 0 },
  ]);
  assert.equal(report.overall.trades, 3);
  assert.equal(report.overall.wins, 1);
  assert.equal(report.overall.losses, 1);
  assert.equal(report.overall.totalPl, 60);
  assert.equal(report.overall.avgPl, 20);
  assert.equal(report.overall.winRate, 0.3333);
});

test("computePerformance groups by tag, an outcome counts toward each of its tags", () => {
  const report = computePerformance([
    { tags: ["momentum", "breakout"], realizedPl: 50 },
    { tags: ["momentum"], realizedPl: -10 },
  ]);
  const byTag = Object.fromEntries(report.byTag.map((row) => [row.tag, row]));
  assert.equal(byTag.momentum!.trades, 2);
  assert.equal(byTag.momentum!.totalPl, 40);
  assert.equal(byTag.breakout!.trades, 1);
  assert.equal(byTag.breakout!.totalPl, 50);
  assert.equal(byTag.breakout!.winRate, 1);
});

test("computePerformance is stable and rounds cleanly on an empty set", () => {
  const report = computePerformance([]);
  assert.equal(report.overall.trades, 0);
  assert.equal(report.overall.winRate, 0);
  assert.equal(report.overall.avgPl, 0);
  assert.deepEqual(report.byTag, []);
});

test("byTag rows are sorted alphabetically for deterministic output", () => {
  const report = computePerformance([
    { tags: ["zeta"], realizedPl: 1 },
    { tags: ["alpha"], realizedPl: 2 },
  ]);
  assert.deepEqual(report.byTag.map((r) => r.tag), ["alpha", "zeta"]);
});

test("float sums round to cents without drift", () => {
  const report = computePerformance([
    { tags: ["x"], realizedPl: 0.1 },
    { tags: ["x"], realizedPl: 0.2 },
  ]);
  assert.equal(report.overall.totalPl, 0.3);
});
