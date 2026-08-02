import type Anthropic from "@anthropic-ai/sdk";
import { getEnabledTools, getTool } from "../tools/registry.js";

/**
 * Agent clusters group the existing registered tools by research specialty,
 * exactly as named in CLAUDE.md. This is a read-only grouping: it changes no
 * tool's tier or behavior, it only decides which tools a given specialist is
 * allowed to see. A specialist can never be handed a tool outside its cluster,
 * and no cluster contains an execution tool.
 */

export type ClusterName =
  | "screener"
  | "technicals"
  | "fundamentals"
  | "filings"
  | "portfolio_risk"
  | "options"
  | "synthesis";

/**
 * Cluster to tool-name allowlist. Names that the live MCP did not register
 * (Robinhood unlinked, or a tool the account lacks) are simply absent at
 * lookup time; the specialist runs with whatever subset is available.
 *
 * No execution tool (place_equity_order, cancel_equity_order,
 * place_option_order, cancel_option_order) appears in any cluster. That
 * exclusion is the core invariant of this phase.
 */
export const AGENT_CLUSTERS: Record<ClusterName, string[]> = {
  screener: [
    "run_scan",
    "get_scans",
    "get_scanner_filter_specs",
    "create_scan",
    "update_scan_filters",
    "get_watchlist_items",
    "get_popular_watchlists",
    "search",
  ],
  technicals: [
    "get_equity_historicals",
    "get_equity_technical_indicators",
    "get_equity_price_book",
    "get_indexes",
    "get_index_quotes",
    // Local Polygon tools so technicals still works when Robinhood is unlinked.
    "get_quote",
    "get_ohlcv",
    "render_chart",
  ],
  fundamentals: [
    "get_equity_fundamentals",
    "get_financials",
    "get_earnings_results",
    "get_earnings_calendar",
    // Cross-check Robinhood's financials against source SEC XBRL.
    "get_company_facts",
  ],
  filings: [
    "get_recent_filings",
    "get_insider_trades",
    "get_earnings_calendar",
  ],
  portfolio_risk: [
    "get_portfolio",
    "get_equity_positions",
    "get_equity_tax_lots",
    "get_realized_pnl",
    "get_pnl_trade_history",
    "get_equity_orders",
    "get_accounts",
  ],
  options: [
    "get_option_chains",
    "get_option_instruments",
    "get_option_quotes",
    "get_option_historicals",
    "get_option_positions",
  ],
  // Synthesis reads tradability and simulates orders; it never holds an
  // execution tool. The mandatory pre-order simulation is also enforced
  // deterministically by the orchestrator, not left to the model.
  synthesis: ["get_equity_tradability", "review_equity_order"],
};

// Execution tools that must never be exposed to any sub-agent, asserted below.
const FORBIDDEN_IN_CLUSTERS = [
  "place_equity_order",
  "cancel_equity_order",
  "place_option_order",
  "cancel_option_order",
];

for (const [cluster, names] of Object.entries(AGENT_CLUSTERS)) {
  for (const forbidden of FORBIDDEN_IN_CLUSTERS) {
    if (names.includes(forbidden)) {
      throw new Error(`Cluster ${cluster} must not contain execution tool ${forbidden}.`);
    }
  }
}

/**
 * The tool schemas a specialist may use: its cluster's tools that are both
 * registered and currently enabled by tier. Anything else is invisible to it.
 */
export function clusterToolSchemas(cluster: ClusterName): Anthropic.Tool[] {
  const allowed = new Set(AGENT_CLUSTERS[cluster]);
  const enabled = new Set(getEnabledTools().map((tool) => tool.name));
  return AGENT_CLUSTERS[cluster]
    .filter((name) => allowed.has(name) && enabled.has(name))
    .map((name) => {
      const tool = getTool(name)!;
      return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
    });
}

/** True when a tool name belongs to the cluster (defense in depth at dispatch). */
export function clusterAllows(cluster: ClusterName, toolName: string): boolean {
  return AGENT_CLUSTERS[cluster].includes(toolName);
}
