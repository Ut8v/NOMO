import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockRobinhood } from "../mocks/mockRobinhoodMcp.js";
import type { MockRobinhood } from "../mocks/mockRobinhoodMcp.js";

// Environment overrides must be in place before any module that reads
// config is imported, so everything config-dependent is imported
// dynamically in before().
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-portfolio-test-"));
process.env.NOMO_DATA_DIR = tempDir;

const MOCK_PORT = 9097;

let mock: MockRobinhood;
let portfolio: typeof import("../../src/services/portfolio.js");
let gate: typeof import("../../src/services/executionGate.js");
let robinhoodMcp: typeof import("../../src/services/robinhoodMcp.js");
let dbModule: typeof import("../../src/db/index.js");

function countPendingOrders(): number {
  const row = dbModule.getDb().prepare("SELECT COUNT(*) AS count FROM pending_orders").get() as {
    count: number;
  };
  return row.count;
}

before(async () => {
  mock = await startMockRobinhood(MOCK_PORT);
  process.env.ROBINHOOD_MCP_URL = mock.url;

  dbModule = await import("../../src/db/index.js");
  dbModule.initDatabase();
  portfolio = await import("../../src/services/portfolio.js");
  gate = await import("../../src/services/executionGate.js");
  robinhoodMcp = await import("../../src/services/robinhoodMcp.js");
  const settings = await import("../../src/db/settings.js");
  settings.setRobinhoodAccountNumber("MOCK-ACCT-1");
  // Discover the live tools so the mandatory simulation is available.
  await robinhoodMcp.connectAndRegisterTools();
});

after(async () => {
  robinhoodMcp.unregisterRobinhoodTools();
  await mock.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("listPositions maps the broker payload to typed views", async () => {
  const positions = await portfolio.listPositions();
  assert.deepEqual(positions, [
    { symbol: "AAPL", quantity: "12", averageBuyPrice: "201.55", marketValue: "2836.20", side: "long" },
    { symbol: "NVDA", quantity: "5", averageBuyPrice: "168.30", marketValue: "912.50", side: "long" },
  ]);
});

test("parsePositions drops entries without a symbol or quantity", () => {
  const parsed = portfolio.parsePositions({
    positions: [{ symbol: "AAPL" }, { quantity: "3" }, null, { symbol: "msft", quantity: 4 }],
  });
  assert.deepEqual(parsed, [
    { symbol: "MSFT", quantity: "4", averageBuyPrice: null, marketValue: null, side: "long" },
  ]);
  assert.deepEqual(portfolio.parsePositions(null), []);
  assert.deepEqual(portfolio.parsePositions({ positions: "nope" }), []);
});

test("close simulates first, creates an awaiting sell for the full position, places nothing", async () => {
  const reviewedBefore = mock.reviewedOrders.length;
  const placedBefore = mock.placedOrders.length;

  const order = await portfolio.proposeClosePosition("aapl");

  assert.equal(order.status, "awaiting_confirmation");
  assert.equal(order.action, "place");
  assert.equal(order.ticker, "AAPL");
  assert.equal(order.side, "sell");
  assert.equal(order.quantity, "12");
  assert.equal(order.orderType, "market");
  assert.match(order.rationale, /portfolio view/);

  // The mandatory simulation ran with the broker-reported quantity.
  assert.equal(mock.reviewedOrders.length, reviewedBefore + 1);
  assert.deepEqual(mock.reviewedOrders[mock.reviewedOrders.length - 1], {
    account_number: "MOCK-ACCT-1",
    symbol: "AAPL",
    side: "sell",
    quantity: "12",
    type: "market",
  });
  const warnings = JSON.parse(order.brokerWarnings ?? "null") as { alerts?: unknown };
  assert.ok(Array.isArray(warnings?.alerts));

  assert.equal(mock.placedOrders.length, placedBefore, "a proposal must not reach the broker");

  const audit = dbModule
    .getDb()
    .prepare("SELECT agent, outcome FROM audit_log WHERE tool_name = 'close_position' ORDER BY id DESC LIMIT 1")
    .get() as { agent: string; outcome: string };
  assert.equal(audit.agent, "portfolio");
  assert.match(audit.outcome, /awaiting confirmation/);
});

test("confirming a close forwards exactly the stored parameters", async () => {
  const order = await portfolio.proposeClosePosition("AAPL");
  const result = await gate.confirmOrder(order.id);

  assert.equal(result.ok, true);
  assert.equal(result.order?.status, "executed");
  assert.deepEqual(mock.placedOrders[mock.placedOrders.length - 1], {
    account_number: "MOCK-ACCT-1",
    symbol: "AAPL",
    side: "sell",
    quantity: "12",
    type: "market",
    ref_id: order.id,
  });
});

test("an invalid ticker is a 400 and writes nothing", async () => {
  const ordersBefore = countPendingOrders();
  await assert.rejects(
    () => portfolio.proposeClosePosition("not a ticker"),
    (err: unknown) => err instanceof portfolio.PortfolioActionError && err.status === 400,
  );
  assert.equal(countPendingOrders(), ordersBefore);
});

test("a ticker without an open long position is a 404 and writes nothing", async () => {
  const ordersBefore = countPendingOrders();
  await assert.rejects(
    () => portfolio.proposeClosePosition("TSLA"),
    (err: unknown) => err instanceof portfolio.PortfolioActionError && err.status === 404,
  );
  assert.equal(countPendingOrders(), ordersBefore);
});

test("a failed simulation creates no pending order", async () => {
  mock.reviewShouldFail = true;
  const ordersBefore = countPendingOrders();
  const placedBefore = mock.placedOrders.length;

  await assert.rejects(() => portfolio.proposeClosePosition("AAPL"), /insufficient buying power/);

  assert.equal(countPendingOrders(), ordersBefore);
  assert.equal(mock.placedOrders.length, placedBefore);
  mock.reviewShouldFail = false;
});

test("listOpenOrders keeps only the resting orders", async () => {
  const orders = await portfolio.listOpenOrders();
  assert.deepEqual(orders, [
    {
      orderId: "RH-OPEN-1",
      symbol: "AAPL",
      side: "buy",
      quantity: "2",
      orderType: "limit",
      limitPrice: "195.00",
      state: "queued",
      createdAt: "2026-08-01T14:00:00Z",
    },
  ]);
});

test("parseOpenOrders drops terminal states and entries without ids, keeps unknown states", () => {
  const parsed = portfolio.parseOpenOrders({
    orders: [
      { id: "A1", symbol: "aapl", side: "sell", quantity: "1", state: "Cancelled" },
      { symbol: "NVDA", side: "buy", quantity: "1", state: "queued" },
      { order_id: "B2", symbol: "msft", side: "buy", state: "who_knows" },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.orderId, "B2");
  assert.equal(parsed[0]?.symbol, "MSFT");
  assert.equal(parsed[0]?.state, "who_knows");
});

test("propose-cancel creates an awaiting cancel and touches no broker order", async () => {
  const cancelledBefore = mock.cancelledOrders.length;

  const order = await portfolio.proposeCancelOpenOrder("RH-OPEN-1");

  assert.equal(order.status, "awaiting_confirmation");
  assert.equal(order.action, "cancel");
  assert.equal(order.ticker, "AAPL");
  assert.equal(order.brokerRef, "RH-OPEN-1");
  assert.match(order.rationale, /portfolio view/);
  assert.equal(mock.cancelledOrders.length, cancelledBefore);

  const audit = dbModule
    .getDb()
    .prepare("SELECT agent, outcome FROM audit_log WHERE tool_name = 'cancel_order' ORDER BY id DESC LIMIT 1")
    .get() as { agent: string; outcome: string };
  assert.equal(audit.agent, "portfolio");
  assert.match(audit.outcome, /awaiting confirmation/);
});

test("confirming a proposed cancel sends the stored broker reference", async () => {
  const order = await portfolio.proposeCancelOpenOrder("RH-OPEN-1");
  const result = await gate.confirmOrder(order.id);

  assert.equal(result.ok, true);
  assert.equal(result.order?.status, "executed");
  assert.deepEqual(mock.cancelledOrders[mock.cancelledOrders.length - 1], { order_id: "RH-OPEN-1" });
});

test("an unknown or missing order id is rejected and writes nothing", async () => {
  const ordersBefore = countPendingOrders();
  await assert.rejects(
    () => portfolio.proposeCancelOpenOrder("RH-DONE-1"),
    (err: unknown) => err instanceof portfolio.PortfolioActionError && err.status === 404,
  );
  await assert.rejects(
    () => portfolio.proposeCancelOpenOrder("   "),
    (err: unknown) => err instanceof portfolio.PortfolioActionError && err.status === 400,
  );
  assert.equal(countPendingOrders(), ordersBefore);
});
