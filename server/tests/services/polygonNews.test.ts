import assert from "node:assert/strict";
import { test } from "node:test";
import { mapNewsResults } from "../../src/services/polygon.js";

const RAW = {
  results: [
    {
      title: "Apple unveils new chip",
      publisher: { name: "TechWire" },
      author: "J. Reporter",
      published_utc: "2026-08-10T13:00:00Z",
      article_url: "https://example.com/apple-chip",
      tickers: ["AAPL", "TSMC"],
      description: "Apple announced a new processor.",
      insights: [
        { ticker: "AAPL", sentiment: "positive", sentiment_reasoning: "New product cycle" },
        { ticker: "TSMC", sentiment: "neutral", sentiment_reasoning: "Supplier" },
      ],
    },
    {
      title: "Markets wobble",
      publisher: { name: "MarketDesk" },
      published_utc: "2026-08-09T20:00:00Z",
      article_url: "https://example.com/markets",
      tickers: ["SPY"],
    },
  ],
};

test("maps articles and picks the requested ticker's sentiment", () => {
  const items = mapNewsResults(RAW, "AAPL");
  assert.equal(items.length, 2);
  const first = items[0]!;
  assert.equal(first.title, "Apple unveils new chip");
  assert.equal(first.publisher, "TechWire");
  assert.equal(first.author, "J. Reporter");
  assert.deepEqual(first.tickers, ["AAPL", "TSMC"]);
  assert.equal(first.sentiment, "positive"); // AAPL insight, not TSMC's
  assert.match(first.sentimentReasoning ?? "", /product cycle/);
});

test("missing fields degrade to nulls, no sentiment when the ticker has no insight", () => {
  const items = mapNewsResults(RAW, "AAPL");
  const second = items[1]!;
  assert.equal(second.author, null);
  assert.equal(second.description, null);
  assert.equal(second.sentiment, null);
});

test("a non-object or empty response yields an empty list", () => {
  assert.deepEqual(mapNewsResults(null, "AAPL"), []);
  assert.deepEqual(mapNewsResults({ results: [] }, "AAPL"), []);
});
