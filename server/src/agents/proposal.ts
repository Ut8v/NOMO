import type { BrokerReview, PendingOrderView } from "@nomo/shared";
import { proposeResearchedOrder } from "../services/executionGate.js";
import { simulateEquityOrder } from "../services/robinhoodMcp.js";
import type { ProposalDraft } from "./synthesis.js";

/**
 * Turns a synthesized proposal into a pending order, but only after a
 * successful pre-trade simulation. This is the single place the orchestrated
 * path creates an order, and it hard-requires the simulation: if review fails
 * or is unavailable, no pending order is created and the reason is returned.
 * It still only writes a pending_orders row; the broker is reached solely by
 * the unchanged confirmation gate.
 */
export interface FinalizeResult {
  order: PendingOrderView | null;
  warnings?: BrokerReview;
  error?: string;
}

export async function finalizeProposal(
  proposal: ProposalDraft,
  thesis: string,
  bearCase: string,
): Promise<FinalizeResult> {
  let warnings: BrokerReview;
  try {
    warnings = await simulateEquityOrder({
      ticker: proposal.ticker,
      side: proposal.side,
      quantity: String(proposal.quantity),
      orderType: proposal.orderType,
      limitPrice: proposal.limitPrice != null ? String(proposal.limitPrice) : null,
      stopPrice: proposal.stopPrice != null ? String(proposal.stopPrice) : null,
    });
  } catch (err) {
    return { order: null, error: err instanceof Error ? err.message : "Order simulation failed." };
  }

  try {
    // Stored JSON-encoded; the confirmation card decodes it for a clean render.
    const { order } = proposeResearchedOrder(proposal, { thesis, bearCase, brokerWarnings: JSON.stringify(warnings) });
    return { order, warnings };
  } catch (err) {
    // Validation rejected the proposal (bad quantity, ticker, and so on).
    return { order: null, error: err instanceof Error ? err.message : "Proposal was invalid." };
  }
}
