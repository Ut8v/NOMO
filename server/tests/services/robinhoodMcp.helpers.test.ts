import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryable, scrubAccountNumbers, stripAccountFromSchema } from "../../src/services/robinhoodMcp.js";

test("scrub hides account_number fields and the exact stored value", () => {
  const raw = {
    orders: [
      { account_number: "ABC12345", symbol: "NVDA", note: "for account ABC12345" },
      { account_number: "ABC12345", symbol: "AAPL" },
    ],
  };
  const scrubbed = scrubAccountNumbers(raw, "ABC12345") as typeof raw;
  assert.equal(scrubbed.orders[0]!.account_number, "[hidden]");
  assert.equal(scrubbed.orders[1]!.account_number, "[hidden]");
  // The value must not survive anywhere, including inside free text.
  assert.doesNotMatch(JSON.stringify(scrubbed), /ABC12345/);
  assert.match(scrubbed.orders[0]!.note as string, /for account \[hidden\]/);
});

test("scrub still hides account_number fields when the value is unknown", () => {
  const scrubbed = scrubAccountNumbers({ account_number: "ZZ999" }, null) as { account_number: string };
  assert.equal(scrubbed.account_number, "[hidden]");
});

test("stripAccountFromSchema removes the field and reports whether it was required", () => {
  const required = stripAccountFromSchema({
    type: "object",
    properties: { account_number: { type: "string" }, symbol: { type: "string" } },
    required: ["account_number", "symbol"],
  });
  assert.equal(required.requiresAccount, true);
  assert.ok(!Object.keys(required.schema.properties ?? {}).includes("account_number"));
  assert.deepEqual(required.schema.required, ["symbol"]);

  const optional = stripAccountFromSchema({
    type: "object",
    properties: { account_number: { type: "string" }, state: { type: "string" } },
    required: ["state"],
  });
  assert.equal(optional.requiresAccount, false);
  assert.ok(!Object.keys(optional.schema.properties ?? {}).includes("account_number"));
});

test("only transient errors are retryable", () => {
  assert.equal(isRetryable(new Error("fetch failed")), true);
  assert.equal(isRetryable(new Error("socket hang up")), true);
  assert.equal(isRetryable(new Error("API error 500")), true);
  assert.equal(isRetryable(new Error("API error 404: Not found")), false);
  assert.equal(isRetryable(new Error("API error 400")), false);
});
