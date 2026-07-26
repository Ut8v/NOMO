import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBrokerReview } from "./brokerReview.js";

// The shape Robinhood actually returned, trimmed to the relevant fields.
const REAL = {
  data: {
    symbol: "NVDA",
    side: "buy",
    type: "limit",
    quantity: "1",
    limit_price: "204.5",
    order_checks: {
      alertType: "EQUITY_NOT_ENOUGH_BP",
      equityNotEnoughBpAlertDetails: { depositAmount: { amount: "104.5000", currency: "USD" }, brokerageAccountType: "INDIVIDUAL" },
    },
    quote_data: { symbol: "NVDA", last_trade_price: "206.960000", bid_price: "206.750000", ask_price: "210.460000" },
    market_data_disclosure: "Bid $206.79 × 200 P · Ask $206.80 × 400 P · Last $206.7999 × 149. Updated 7:59 PM ET.",
  },
  guide: "This tool does NOT place the order. You MUST present the preview and get explicit confirmation before calling place_equity_order...",
};

test("surfaces the buying-power alert and drops the broker's guide", () => {
  const review = parseBrokerReview(REAL);
  assert.equal(review.alerts.length, 1);
  assert.match(review.alerts[0]!, /Insufficient buying power/);
  assert.match(review.alerts[0]!, /\$104\.50 short/);
  // The guide (model-directed instructions) must never appear anywhere.
  const serialized = JSON.stringify(review);
  assert.doesNotMatch(serialized, /MUST present the preview/);
  assert.doesNotMatch(serialized, /place_equity_order/);
});

test("keeps the compliance disclosure verbatim", () => {
  const review = parseBrokerReview(REAL);
  assert.equal(review.disclosure, REAL.data.market_data_disclosure);
});

test("builds a limit vs bid/ask summary", () => {
  const review = parseBrokerReview(REAL);
  assert.match(review.summary ?? "", /Limit \$204\.50/);
  assert.match(review.summary ?? "", /bid \$206\.75/);
  assert.match(review.summary ?? "", /ask \$210\.46/);
});

test("empty order_checks yields no alerts", () => {
  const review = parseBrokerReview({ data: { order_checks: {}, market_data_disclosure: "quote line" } });
  assert.deepEqual(review.alerts, []);
  assert.equal(review.disclosure, "quote line");
});

test("handles the mock-style flat response", () => {
  const review = parseBrokerReview({ estimated_cost: "236.35", buying_power_ok: true });
  assert.deepEqual(review.alerts, []);
  assert.match(review.summary ?? "", /Estimated cost \$236\.35/);
});

test("non-JSON string degrades to a safe summary", () => {
  const review = parseBrokerReview("Robinhood is unreachable");
  assert.deepEqual(review.alerts, []);
  assert.equal(review.summary, "Robinhood is unreachable");
});
