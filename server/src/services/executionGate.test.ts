import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockRobinhood } from "../../test/mockRobinhoodMcp.js";
import type { MockRobinhood } from "../../test/mockRobinhoodMcp.js";

// Environment overrides must be in place before any module that reads
// config is imported, so everything config-dependent is imported
// dynamically in before().
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-gate-test-"));
process.env.NOMO_DATA_DIR = tempDir;

const MOCK_PORT = 9096;

let mock: MockRobinhood;
let gate: typeof import("./executionGate.js");
let robinhoodMcp: typeof import("./robinhoodMcp.js");
let dbModule: typeof import("../db/index.js");

before(async () => {
  mock = await startMockRobinhood(MOCK_PORT);
  process.env.ROBINHOOD_MCP_URL = mock.url;

  dbModule = await import("../db/index.js");
  dbModule.initDatabase();
  gate = await import("./executionGate.js");
  robinhoodMcp = await import("./robinhoodMcp.js");
});

after(async () => {
  await mock.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function propose(overrides: Record<string, unknown> = {}) {
  return gate.proposeOrder({
    ticker: "AAPL",
    side: "buy",
    quantity: 1,
    order_type: "market",
    rationale: "integration test order",
    ...overrides,
  });
}

function backdateExpiry(orderId: string): void {
  dbModule
    .getDb()
    .prepare("UPDATE pending_orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
    .run(orderId);
}

test("propose creates an awaiting order and does not touch the broker", () => {
  const { forModel, order } = propose();
  assert.equal(order.status, "awaiting_confirmation");
  assert.equal(order.ticker, "AAPL");
  assert.equal(order.quantity, "1");
  assert.ok(new Date(order.expiresAt).getTime() > Date.now());
  assert.match(JSON.stringify(forModel), /NOT placed/);
  assert.equal(mock.placedOrders.length, 0);
});

test("propose rejects invalid input", () => {
  assert.throws(() => propose({ ticker: "not a ticker" }), /ticker/);
  assert.throws(() => propose({ side: "hold" }), /side/);
  assert.throws(() => propose({ quantity: -3 }), /quantity/);
  assert.throws(() => propose({ order_type: "limit" }), /limit_price/);
  assert.throws(() => propose({ rationale: "  " }), /rationale/);
  assert.equal(mock.placedOrders.length, 0);
});

test("confirm forwards exactly the stored parameters and records the ack", async () => {
  const { order } = propose({ ticker: "TSLA", side: "buy", quantity: 2, order_type: "limit", limit_price: 100.5 });
  const result = await gate.confirmOrder(order.id);

  assert.equal(result.ok, true);
  assert.equal(result.order?.status, "executed");
  assert.match(result.order?.result ?? "", /RH-MOCK/);
  assert.equal(mock.placedOrders.length, 1);
  assert.deepEqual(mock.placedOrders[0], {
    symbol: "TSLA",
    side: "buy",
    quantity: "2",
    order_type: "limit",
    limit_price: "100.5",
  });
});

test("confirming twice is a conflict and places nothing extra", async () => {
  const { order } = propose();
  const first = await gate.confirmOrder(order.id);
  assert.equal(first.ok, true);
  const placedAfterFirst = mock.placedOrders.length;

  const second = await gate.confirmOrder(order.id);
  assert.equal(second.ok, false);
  assert.equal(second.code, "conflict");
  assert.equal(mock.placedOrders.length, placedAfterFirst);
});

test("reject resolves the order and never touches the broker", async () => {
  const { order } = propose({ ticker: "NVDA" });
  const placedBefore = mock.placedOrders.length;

  const result = gate.rejectOrder(order.id);
  assert.equal(result.ok, true);
  assert.equal(result.order?.status, "rejected");

  const confirmAfter = await gate.confirmOrder(order.id);
  assert.equal(confirmAfter.ok, false);
  assert.equal(confirmAfter.code, "conflict");
  assert.equal(mock.placedOrders.length, placedBefore);
});

test("expired orders cannot be confirmed", async () => {
  const { order } = propose({ ticker: "MSFT" });
  const placedBefore = mock.placedOrders.length;
  backdateExpiry(order.id);

  const result = await gate.confirmOrder(order.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, "conflict");
  assert.equal(result.order?.status, "expired");
  assert.equal(mock.placedOrders.length, placedBefore);
});

test("expired orders cannot be rejected either, they are already resolved", () => {
  const { order } = propose();
  backdateExpiry(order.id);
  const result = gate.rejectOrder(order.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, "conflict");
  assert.equal(result.order?.status, "expired");
});

test("unknown order ids are not found", async () => {
  const confirm = await gate.confirmOrder("does-not-exist");
  assert.equal(confirm.ok, false);
  assert.equal(confirm.code, "not_found");
});

test("placeConfirmedOrder refuses any order not in confirmed status", async () => {
  const { order } = propose();
  const placedBefore = mock.placedOrders.length;
  await assert.rejects(() => robinhoodMcp.placeConfirmedOrder(order), /not confirmed/);
  for (const status of ["rejected", "expired", "executed", "failed"] as const) {
    await assert.rejects(
      () => robinhoodMcp.placeConfirmedOrder({ ...order, status }),
      /not confirmed/,
    );
  }
  assert.equal(mock.placedOrders.length, placedBefore);
});

test("audit log records the full lifecycle", async () => {
  const { order } = propose({ ticker: "AMD" });
  await gate.confirmOrder(order.id);
  const rows = dbModule
    .getDb()
    .prepare("SELECT outcome FROM audit_log WHERE tool_name = 'place_equity_order' ORDER BY id DESC LIMIT 1")
    .all() as { outcome: string }[];
  assert.equal(rows[0]?.outcome, "executed");
});
