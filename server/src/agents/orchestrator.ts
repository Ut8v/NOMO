import type { AgentEvent, ChartSpec, PendingOrderView, ToolEvent } from "@nomo/shared";
import { isAgentEnabled } from "../db/settings.js";
import { finalizeProposal } from "./proposal.js";
import { runSpecialist, SPECIALISTS } from "./specialist.js";
import type { SpecialistDef, SpecialistOutcome } from "./specialist.js";
import { runSkeptic, runSynthesis } from "./synthesis.js";

/**
 * Coordinates a research run: it plans which specialists a request needs, fans
 * the independent ones out concurrently under a per-agent timeout, hands their
 * findings to synthesis, runs the skeptic on any proposal, and simulates before
 * a pending order is ever created. It holds no execution tool and creates an
 * order only through finalizeProposal, which requires a successful simulation.
 */

const AGENT_TIMEOUT_MS = 45_000;
const TICKER_PATTERN = /\b[A-Z]{1,5}\b/g;
// Common all-caps words that are not tickers, to keep the heuristic sane.
const STOPWORDS = new Set(["I", "A", "THE", "BUY", "SELL", "USD", "EPS", "CEO", "ETF", "AI", "US", "IPO", "AND", "OR", "NOMO"]);

export interface OrchestratorSink {
  onAgent?: (event: AgentEvent) => void;
  onToolEvent?: (event: ToolEvent) => void;
  onChart?: (spec: ChartSpec) => void;
}

export interface OrchestratorResult {
  /** Compact text summary handed back to the main chat loop as a tool result. */
  summary: unknown;
  /** Created only when synthesis proposed a trade and simulation succeeded. */
  order: PendingOrderView | null;
  /** Per-agent cost for the run summary. */
  costs: Array<{ agent: string; costUsd: number }>;
}

interface PlannedAgent {
  def: SpecialistDef;
  task: string;
}

/**
 * Decides which specialists to run. Deterministic and cheap: no extra model
 * call. Tickers mentioned in the request focus the price and account agents; a
 * request with no ticker leans on the screener for idea generation. The options
 * specialist runs only when enabled in settings.
 */
export function planSpecialists(question: string): PlannedAgent[] {
  const tickers = [...new Set((question.toUpperCase().match(TICKER_PATTERN) ?? []).filter((t) => !STOPWORDS.has(t)))];
  const focus = tickers.length > 0 ? `Focus on ${tickers.join(", ")}. ` : "";
  const plan: PlannedAgent[] = [];
  for (const def of SPECIALISTS) {
    if (!isAgentEnabled(def.name, def.defaultEnabled)) continue;
    // Without a named ticker the screener earns its place; with one, price and
    // fundamentals and risk matter most, and the screener can still run.
    plan.push({ def, task: `${focus}${question}` });
  }
  return plan;
}

async function withTimeout(
  def: SpecialistDef,
  external: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<SpecialistOutcome>,
): Promise<SpecialistOutcome> {
  // The specialist listens to a single combined signal so that either the
  // per-agent timeout OR the outer request actually cancels its in-flight
  // model stream, rather than the timeout abandoning a request that keeps
  // running and accruing cost.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SpecialistOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ agent: def.name, findings: null, error: "timed out", costUsd: 0, tokens: { input: 0, output: 0 } });
    }, AGENT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

export async function runResearch(
  question: string,
  sink: OrchestratorSink = {},
  signal?: AbortSignal,
): Promise<OrchestratorResult> {
  const plan = planSpecialists(question);
  const costs: Array<{ agent: string; costUsd: number }> = [];

  // Fan out: every planned specialist runs concurrently. A timeout or failure
  // marks that agent missing; it never blocks the others or the run.
  const outcomes = await Promise.all(
    plan.map(async ({ def, task }) => {
      sink.onAgent?.({ name: def.name, phase: "start" });
      const outcome = await withTimeout(def, signal, (agentSignal) =>
        runSpecialist(def, task, { onToolEvent: sink.onToolEvent, onChart: sink.onChart }, agentSignal),
      );
      sink.onAgent?.({ name: def.name, phase: "end", ok: outcome.findings !== null });
      costs.push({ agent: def.name, costUsd: outcome.costUsd });
      return outcome;
    }),
  );

  const findings = outcomes.map((o) => ({ agent: o.agent, findings: o.findings }));
  const present = findings.filter((f) => f.findings !== null).length;

  sink.onAgent?.({ name: "synthesis", phase: "start" });
  const synth = await runSynthesis(question, findings, { onToolEvent: sink.onToolEvent }, signal);
  costs.push({ agent: "synthesis", costUsd: synth.costUsd });
  sink.onAgent?.({ name: "synthesis", phase: "end", ok: true });

  if (!synth.proposal) {
    return {
      summary: {
        thesis: synth.thesis,
        proposal: null,
        specialistsRun: findings.length,
        specialistsWithFindings: present,
        note: "No trade was proposed. Relay the thesis to the user.",
      },
      order: null,
      costs,
    };
  }

  const portfolio = findings.find((f) => f.agent === "portfolio_risk")?.findings ?? null;
  sink.onAgent?.({ name: "skeptic", phase: "start" });
  const skeptic = await runSkeptic(synth.thesis, synth.proposal, portfolio, signal);
  costs.push({ agent: "skeptic", costUsd: skeptic.costUsd });
  sink.onAgent?.({ name: "skeptic", phase: "end", ok: true });

  const finalized = await finalizeProposal(synth.proposal, synth.thesis, skeptic.bearCase);
  if (!finalized.order) {
    return {
      summary: {
        thesis: synth.thesis,
        proposal: null,
        simulationFailed: true,
        error: finalized.error,
        note: "A trade was considered but its pre-trade simulation failed, so no proposal was created. Report the failure to the user.",
      },
      order: null,
      costs,
    };
  }

  return {
    summary: {
      thesis: synth.thesis,
      bearCase: skeptic.bearCase,
      proposalCreated: true,
      orderId: finalized.order.id,
      specialistsWithFindings: present,
      note: "A proposal was created and is awaiting the user's confirmation in the app. Do NOT say it executed.",
    },
    order: finalized.order,
    costs,
  };
}
