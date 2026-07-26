import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockRobinhood } from "../../test/mockRobinhoodMcp.js";
import type { MockRobinhood } from "../../test/mockRobinhoodMcp.js";
import { startMockAnthropic } from "../../test/mockAnthropic.js";
import type { MockAnthropic, AnthropicRequestBody, MockAssistantReply } from "../../test/mockAnthropic.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-specialist-test-"));
process.env.NOMO_DATA_DIR = tempDir;

let mockRh: MockRobinhood;
let mockAnthropic: MockAnthropic;
let specialist: typeof import("./specialist.js");
let clusters: typeof import("./clusters.js");
let robinhoodMcp: typeof import("../services/robinhoodMcp.js");
let credentials: typeof import("../db/credentials.js");

// The mock reply is swapped per test so one server handles every scenario.
let responder: (body: AnthropicRequestBody) => MockAssistantReply = () => ({ blocks: [] });

before(async () => {
  mockRh = await startMockRobinhood(9094);
  process.env.ROBINHOOD_MCP_URL = mockRh.url;
  mockAnthropic = await startMockAnthropic((body) => responder(body));
  process.env.ANTHROPIC_BASE_URL = mockAnthropic.url;

  const dbModule = await import("../db/index.js");
  dbModule.initDatabase();
  credentials = await import("../db/credentials.js");
  credentials.setCredential("anthropic", "sk-test");
  specialist = await import("./specialist.js");
  clusters = await import("./clusters.js");
  robinhoodMcp = await import("../services/robinhoodMcp.js");
  await robinhoodMcp.connectAndRegisterTools();
});

after(async () => {
  robinhoodMcp.unregisterRobinhoodTools();
  await mockRh.close();
  await mockAnthropic.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const TECHNICALS = { name: "technicals", cluster: "technicals" as const, defaultEnabled: true, focus: "test" };

test("specialist calls a cluster tool then returns validated findings", async () => {
  // First turn: call a read tool. Second turn (after a tool_result): emit findings.
  responder = (body) => {
    const sawToolResult = body.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: unknown) => (b as { type?: string }).type === "tool_result"),
    );
    if (!sawToolResult) {
      return { blocks: [{ type: "tool_use", id: "t1", name: "get_equity_quotes", input: { symbols: "AAPL" } }] };
    }
    return {
      blocks: [
        {
          type: "tool_use",
          id: "f1",
          name: "emit_findings",
          input: {
            ticker: "AAPL",
            signals: [{ name: "quote", value: "reads ok", direction: "neutral", confidence: 0.4 }],
            sources: ["get_equity_quotes"],
          },
        },
      ],
    };
  };

  const outcome = await specialist.runSpecialist(TECHNICALS, "Look at AAPL");
  assert.equal(outcome.findings?.ticker, "AAPL");
  assert.equal(outcome.findings?.signals.length, 1);
  assert.ok(outcome.costUsd >= 0);
});

test("a bad findings object is rejected and retried once", async () => {
  let call = 0;
  responder = () => {
    call += 1;
    if (call === 1) {
      // Invalid: confidence out of range.
      return {
        blocks: [
          { type: "tool_use", id: "bad", name: "emit_findings", input: { ticker: "AAPL", signals: [{ name: "x", value: "1", direction: "bullish", confidence: 9 }] } },
        ],
      };
    }
    return {
      blocks: [
        { type: "tool_use", id: "good", name: "emit_findings", input: { ticker: "AAPL", signals: [], sources: [] } },
      ],
    };
  };

  const outcome = await specialist.runSpecialist(TECHNICALS, "Look at AAPL");
  assert.ok(outcome.findings, "should recover on the retry");
  assert.equal(call, 2, "exactly one retry");
});

test("two invalid emissions fail the specialist as missing", async () => {
  responder = () => ({
    blocks: [
      { type: "tool_use", id: "bad", name: "emit_findings", input: { ticker: "", signals: [] } },
    ],
  });
  const outcome = await specialist.runSpecialist(TECHNICALS, "Look at AAPL");
  assert.equal(outcome.findings, null);
  assert.match(outcome.error ?? "", /invalid findings/);
});

test("no specialist is ever handed an execution tool", () => {
  for (const def of specialist.SPECIALISTS) {
    const schemas = clusters.clusterToolSchemas(def.cluster);
    const names = schemas.map((s) => s.name);
    for (const execTool of ["place_equity_order", "cancel_equity_order", "place_option_order", "cancel_option_order"]) {
      assert.ok(!names.includes(execTool), `${def.name} must not see ${execTool}`);
    }
  }
});
