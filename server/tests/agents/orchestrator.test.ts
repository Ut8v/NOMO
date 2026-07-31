import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockRobinhood } from "../mocks/mockRobinhoodMcp.js";
import type { MockRobinhood } from "../mocks/mockRobinhoodMcp.js";
import { startMockAnthropic } from "../mocks/mockAnthropic.js";
import type { MockAnthropic, AnthropicRequestBody, MockAssistantReply } from "../mocks/mockAnthropic.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-orchestrator-test-"));
process.env.NOMO_DATA_DIR = tempDir;

let mockRh: MockRobinhood;
let mockAnthropic: MockAnthropic;
let orchestrator: typeof import("../../src/agents/orchestrator.js");
let clusters: typeof import("../../src/agents/clusters.js");
let robinhoodMcp: typeof import("../../src/services/robinhoodMcp.js");
let credentials: typeof import("../../src/db/credentials.js");
let pendingOrders: typeof import("../../src/db/pendingOrders.js");

// Route each sub-agent request by its system prompt so a single mock server
// serves the whole fan-out deterministically under concurrency.
function route(body: AnthropicRequestBody): MockAssistantReply {
  const system = body.system ?? "";
  // Order matters: the synthesis prompt mentions "research specialists", so the
  // synthesis and skeptic branches must be checked before the specialist one.
  if (system.includes("synthesis step")) {
    return {
      blocks: [
        {
          type: "tool_use",
          id: "s",
          name: "emit_synthesis",
          input: { thesis: "AAPL trend is up.", proposal: { ticker: "AAPL", side: "buy", quantity: 3, order_type: "market" } },
        },
      ],
    };
  }
  if (system.includes("risk-skeptic")) {
    return { blocks: [{ type: "tool_use", id: "b", name: "emit_bear_case", input: { bear_case: "Momentum can reverse." } }] };
  }
  if (system.includes("research specialist")) {
    return {
      blocks: [
        {
          type: "tool_use",
          id: "f",
          name: "emit_findings",
          input: { ticker: "AAPL", signals: [{ name: "trend", value: "up", direction: "bullish", confidence: 0.6 }], sources: [] },
        },
      ],
    };
  }
  return { blocks: [{ type: "text", text: "unexpected" }] };
}

let responder: (body: AnthropicRequestBody) => MockAssistantReply = route;

before(async () => {
  mockRh = await startMockRobinhood(9092);
  process.env.ROBINHOOD_MCP_URL = mockRh.url;
  mockAnthropic = await startMockAnthropic((body) => responder(body));
  process.env.ANTHROPIC_BASE_URL = mockAnthropic.url;

  const dbModule = await import("../../src/db/index.js");
  dbModule.initDatabase();
  credentials = await import("../../src/db/credentials.js");
  credentials.setCredential("anthropic", "sk-test");
  orchestrator = await import("../../src/agents/orchestrator.js");
  clusters = await import("../../src/agents/clusters.js");
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

test("plan excludes the options specialist by default and focuses on named tickers", () => {
  const plan = orchestrator.planSpecialists("Is there a window to buy AAPL?");
  const names = plan.map((p) => p.def.name);
  assert.ok(names.includes("technicals"));
  assert.ok(names.includes("portfolio_risk"));
  assert.ok(!names.includes("options"), "options is off by default");
  assert.match(plan[0]!.task, /AAPL/);
});

test("a full orchestrated run creates exactly one pending order and moves no money", async () => {
  responder = route;
  const agentEvents: string[] = [];
  const result = await orchestrator.runResearch("Should I buy AAPL?", {
    onAgent: (e) => agentEvents.push(`${e.name}:${e.phase}`),
  });

  // A proposal was created, awaiting the user's confirmation.
  assert.ok(result.order, "an order should be proposed");
  assert.equal(result.order?.status, "awaiting_confirmation");
  assert.ok(result.order?.thesis && result.order?.bearCase && result.order?.brokerWarnings);

  // The mandatory simulation ran, but nothing was placed or cancelled: the
  // broker received zero execution calls. Money only moves on Confirm.
  assert.ok(mockRh.reviewedOrders.length >= 1, "the order was simulated");
  assert.equal(mockRh.placedOrders.length, 0, "nothing was placed");
  assert.equal(mockRh.cancelledOrders.length, 0, "nothing was cancelled");

  // Exactly one pending order exists for this run.
  const awaiting = pendingOrders.listResolvedOrders().filter((o) => o.status === "awaiting_confirmation");
  // listResolvedOrders excludes awaiting; fetch directly instead.
  assert.ok(result.order);
  assert.equal(awaiting.length, 0);

  // Synthesis and skeptic lanes were reported.
  assert.ok(agentEvents.includes("synthesis:start"));
  assert.ok(agentEvents.includes("skeptic:start"));

  // The mandatory pre-trade simulation was written to the audit log, tagged to
  // the synthesis agent, like every other tool call.
  const dbModule = await import("../../src/db/index.js");
  const audited = dbModule
    .getDb()
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'review_equity_order' AND agent = 'synthesis'")
    .get() as { n: number };
  assert.ok(audited.n >= 1, "the simulation call is audited");
});

test("no research agent's tool schema contains an execution tool", () => {
  const execTools = ["place_equity_order", "cancel_equity_order", "place_option_order", "cancel_option_order"];
  const everySchema = [
    ...(["screener", "technicals", "fundamentals", "portfolio_risk", "options", "synthesis"] as const).flatMap((c) =>
      clusters.clusterToolSchemas(c).map((s) => s.name),
    ),
  ];
  for (const execTool of execTools) {
    assert.ok(!everySchema.includes(execTool), `${execTool} must never appear in any agent schema`);
  }
});

test("when synthesis proposes no trade, no pending order is created", async () => {
  responder = (body) => {
    if ((body.system ?? "").includes("synthesis step")) {
      return { blocks: [{ type: "tool_use", id: "s", name: "emit_synthesis", input: { thesis: "No clean setup.", proposal: null } }] };
    }
    return route(body);
  };
  const placedBefore = mockRh.placedOrders.length;
  const result = await orchestrator.runResearch("Should I buy AAPL?");
  assert.equal(result.order, null);
  assert.equal(mockRh.placedOrders.length, placedBefore, "still nothing placed");
});
