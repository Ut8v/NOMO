import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockRobinhood } from "../mocks/mockRobinhoodMcp.js";
import type { MockRobinhood } from "../mocks/mockRobinhoodMcp.js";
import { startMockAnthropic } from "../mocks/mockAnthropic.js";
import type { MockAnthropic, AnthropicRequestBody, MockAssistantReply } from "../mocks/mockAnthropic.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-synthesis-test-"));
process.env.NOMO_DATA_DIR = tempDir;

let mockRh: MockRobinhood;
let mockAnthropic: MockAnthropic;
let synthesis: typeof import("../../src/agents/synthesis.js");
let proposalMod: typeof import("../../src/agents/proposal.js");
let robinhoodMcp: typeof import("../../src/services/robinhoodMcp.js");
let credentials: typeof import("../../src/db/credentials.js");
let pendingOrders: typeof import("../../src/db/pendingOrders.js");

let responder: (body: AnthropicRequestBody) => MockAssistantReply = () => ({ blocks: [] });

before(async () => {
  mockRh = await startMockRobinhood(9093);
  process.env.ROBINHOOD_MCP_URL = mockRh.url;
  mockAnthropic = await startMockAnthropic((body) => responder(body));
  process.env.ANTHROPIC_BASE_URL = mockAnthropic.url;

  const dbModule = await import("../../src/db/index.js");
  dbModule.initDatabase();
  credentials = await import("../../src/db/credentials.js");
  credentials.setCredential("anthropic", "sk-test");
  synthesis = await import("../../src/agents/synthesis.js");
  proposalMod = await import("../../src/agents/proposal.js");
  robinhoodMcp = await import("../../src/services/robinhoodMcp.js");
  pendingOrders = await import("../../src/db/pendingOrders.js");
  const settings = await import("../../src/db/settings.js");
  settings.setRobinhoodAccountNumber("MOCK-ACCT-1");
  await robinhoodMcp.connectAndRegisterTools();
});

after(async () => {
  robinhoodMcp.unregisterRobinhoodTools();
  await mockRh.close();
  await mockAnthropic.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const FINDINGS = [
  {
    agent: "technicals",
    findings: { ticker: "AAPL", signals: [{ name: "trend", value: "up", direction: "bullish" as const, confidence: 0.7 }], sources: [] },
  },
];

test("synthesis returns a thesis and at most one proposal", async () => {
  responder = () => ({
    blocks: [
      {
        type: "tool_use",
        id: "s1",
        name: "emit_synthesis",
        input: { thesis: "AAPL is trending up.", proposal: { ticker: "AAPL", side: "buy", quantity: 2, order_type: "market" } },
      },
    ],
  });
  const result = await synthesis.runSynthesis("Should I buy AAPL?", FINDINGS);
  assert.match(result.thesis, /AAPL/);
  assert.equal(result.proposal?.ticker, "AAPL");
  assert.equal(result.proposal?.quantity, 2);
});

test("skeptic returns a bear case", async () => {
  responder = () => ({
    blocks: [{ type: "tool_use", id: "b1", name: "emit_bear_case", input: { bear_case: "Concentration risk is high." } }],
  });
  const result = await synthesis.runSkeptic(
    "AAPL is trending up.",
    { ticker: "AAPL", side: "buy", quantity: 2, orderType: "market" },
    FINDINGS[0]!.findings,
  );
  assert.match(result.bearCase, /Concentration/);
});

test("finalize simulates then creates one pending order awaiting confirmation", async () => {
  const before = pendingOrders.listResolvedOrders().length;
  const result = await proposalMod.finalizeProposal(
    { ticker: "AAPL", side: "buy", quantity: 2, orderType: "market" },
    "thesis",
    "bear case",
  );
  assert.ok(result.order, "an order should be created");
  assert.equal(result.order?.status, "awaiting_confirmation");
  assert.equal(result.order?.thesis, "thesis");
  assert.equal(result.order?.bearCase, "bear case");
  assert.ok(result.order?.brokerWarnings, "broker warnings from the simulation are stored");
  // Nothing has been executed; it is still only a proposal.
  assert.equal(before, pendingOrders.listResolvedOrders().length);
});

test("a failed simulation creates no pending order", async () => {
  // Point at an unlinked provider so review_equity_order is unavailable.
  robinhoodMcp.unregisterRobinhoodTools();
  const result = await proposalMod.finalizeProposal(
    { ticker: "AAPL", side: "buy", quantity: 2, orderType: "market" },
    "thesis",
    "bear case",
  );
  assert.equal(result.order, null);
  assert.match(result.error ?? "", /simulation|unavailable|review/i);
  await robinhoodMcp.connectAndRegisterTools();
});
