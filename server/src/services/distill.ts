import Anthropic from "@anthropic-ai/sdk";
import type { PendingOrderView } from "@nomo/shared";
import { config } from "../config.js";
import { getCredential } from "../db/credentials.js";
import { createMemory } from "../db/memories.js";
import { listResolvedOrders } from "../db/pendingOrders.js";

/**
 * Distillation reads the user's confirm and reject history (with veto
 * reasons) and asks Claude to name durable preferences. The results are
 * written as PENDING memories: they never reach the prompt until the user
 * approves them in settings. This flow only ever writes to the memories
 * table; it has no connection to the confirmation gate.
 */

const MIN_HISTORY = 3;
const MAX_CANDIDATES = 5;

export interface DistillResult {
  created: number;
  candidates: string[];
  note: string;
}

function describeOrder(order: PendingOrderView): string {
  const subject =
    order.action === "cancel"
      ? `cancel ${order.ticker} order ${order.brokerRef ?? ""}`.trim()
      : `${order.side} ${order.quantity} ${order.ticker} ${order.orderType}${order.limitPrice ? ` at ${order.limitPrice}` : ""}`;
  const outcome =
    order.status === "rejected"
      ? `rejected by user${order.rejectReason ? ` (reason: ${order.rejectReason})` : ""}`
      : order.status;
  return `- ${subject}. Rationale: ${order.rationale}. Outcome: ${outcome}.`;
}

function parseCandidates(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => item.slice(0, 500))
      .slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}

export async function distillLessons(): Promise<DistillResult> {
  const history = listResolvedOrders(100).filter(
    (order) => order.status === "rejected" || order.status === "executed",
  );
  if (history.length < MIN_HISTORY) {
    return {
      created: 0,
      candidates: [],
      note: "Not enough confirmed or rejected orders yet to find durable patterns. Try again after more trading decisions.",
    };
  }

  const apiKey = getCredential("anthropic");
  if (!apiKey) {
    throw new Error("No Anthropic API key is stored. Run setup first.");
  }

  const client = new Anthropic({ apiKey, baseURL: config.anthropicBaseUrl });
  const message = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system:
      "You analyze a user's trading decision history to extract durable preferences about them as a trader. Output ONLY a JSON array of short strings, each a durable, generalizable fact about the user's preferences or risk behavior. No prose, no code fences. Return an empty array if nothing durable stands out. Never restate an individual trade.",
    messages: [
      {
        role: "user",
        content: `Here are recent confirm and reject decisions:\n\n${history.map(describeOrder).join("\n")}\n\nReturn a JSON array of at most ${MAX_CANDIDATES} durable facts about this user as a trader.`,
      },
    ],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const candidates = parseCandidates(text);
  for (const content of candidates) {
    createMemory({ content, source: "distilled", status: "pending" });
  }

  return {
    created: candidates.length,
    candidates,
    note:
      candidates.length > 0
        ? `Wrote ${candidates.length} candidate lesson(s) to the review list in settings. Nothing is used until the user approves it.`
        : "No durable patterns stood out this time.",
  };
}
