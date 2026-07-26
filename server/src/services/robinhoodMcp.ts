import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { PendingOrderView } from "@nomo/shared";
import { config } from "../config.js";
import { registerTool, unregisterTool } from "../tools/registry.js";
import type { ToolTier } from "../tools/registry.js";
import { RobinhoodOAuthProvider } from "./robinhoodAuth.js";

/**
 * Allowlist mapping each Robinhood tool we expose to its tier. Only tools
 * named here AND present in the live tools/list response are registered as
 * model tools.
 *
 * Every money-moving order tool (place/cancel/review, equities and options,
 * option exercise) is deliberately ABSENT: those are never registered as
 * model tools and are reachable only through the confirmation gate via
 * executeConfirmedOrder. account_write tools change account state but move no
 * money, so they auto-run (subject to the settings toggle) rather than going
 * through the order gate.
 */
const TOOL_TIERS: Record<string, ToolTier> = {
  // Account, portfolio, and P/L reads.
  get_accounts: "portfolio_read",
  get_portfolio: "portfolio_read",
  get_realized_pnl: "portfolio_read",
  get_pnl_trade_history: "portfolio_read",
  search: "portfolio_read",
  // Equity reads.
  get_equity_positions: "portfolio_read",
  get_equity_orders: "portfolio_read",
  get_equity_quotes: "portfolio_read",
  get_equity_tradability: "portfolio_read",
  get_equity_tax_lots: "portfolio_read",
  // Market data reads.
  get_equity_historicals: "portfolio_read",
  get_equity_fundamentals: "portfolio_read",
  get_financials: "portfolio_read",
  get_equity_price_book: "portfolio_read",
  get_equity_technical_indicators: "portfolio_read",
  get_earnings_results: "portfolio_read",
  get_earnings_calendar: "portfolio_read",
  get_indexes: "portfolio_read",
  get_index_quotes: "portfolio_read",
  // Options reads.
  get_option_positions: "portfolio_read",
  get_option_orders: "portfolio_read",
  get_option_quotes: "portfolio_read",
  get_option_chains: "portfolio_read",
  get_option_instruments: "portfolio_read",
  get_option_historicals: "portfolio_read",
  get_option_watchlist: "portfolio_read",
  get_option_level_upgrade_info: "portfolio_read",
  // Watchlist and scanner reads.
  get_watchlists: "portfolio_read",
  get_watchlist_items: "portfolio_read",
  get_popular_watchlists: "portfolio_read",
  get_scans: "portfolio_read",
  get_scanner_filter_specs: "portfolio_read",
  run_scan: "portfolio_read",
  // Order simulation. Previews an order and returns pre-trade warnings; it
  // places nothing and moves no money, so it reads at portfolio_read. The
  // synthesis step relies on this to simulate before any pending order.
  review_equity_order: "portfolio_read",
  review_option_order: "portfolio_read",
  // Account changes: reversible, no money moves. Auto-run, toggleable.
  create_watchlist: "account_write",
  update_watchlist: "account_write",
  follow_watchlist: "account_write",
  unfollow_watchlist: "account_write",
  add_to_watchlist: "account_write",
  remove_from_watchlist: "account_write",
  add_option_to_watchlist: "account_write",
  remove_option_from_watchlist: "account_write",
  create_scan: "account_write",
  update_scan_filters: "account_write",
  update_scan_config: "account_write",
};

export const oauthProvider = new RobinhoodOAuthProvider();

let client: Client | null = null;
let connecting: Promise<Client> | null = null;
let registeredToolNames: string[] = [];
// Every tool the live MCP exposed at connect time, used to decide whether an
// optional review step is available before placing an order.
let availableToolNames = new Set<string>();
// Incremented by unlink so results from a connect that was in flight when
// the user unlinked are discarded instead of resurrecting the session.
let generation = 0;

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(config.robinhoodMcpUrl), {
    authProvider: oauthProvider,
  });
  const mcpClient = new Client({ name: "nomo", version: "0.1.0" });
  await mcpClient.connect(transport);
  return mcpClient;
}

async function ensureClient(): Promise<Client> {
  if (client) return client;
  if (!connecting) {
    const startedGeneration = generation;
    connecting = connect()
      .then((c) => {
        if (startedGeneration !== generation) {
          void c.close().catch(() => undefined);
          throw new Error("Robinhood connection cancelled by unlink.");
        }
        client = c;
        // Guarded so a stale client closing later cannot null out a
        // healthy replacement.
        c.onclose = () => {
          if (client === c) client = null;
        };
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

/**
 * Maps transport failures to messages the model can safely relay. An
 * unauthorized failure means the refresh token is dead, so the tools are
 * unregistered, which flips settings into its Reconnect state.
 */
function translateConnectionError(err: unknown): Error {
  if (err instanceof UnauthorizedError) {
    unregisterRobinhoodTools();
    return new Error(
      "The Robinhood session has expired and could not be refreshed. Ask the user to open Settings and reconnect Robinhood.",
    );
  }
  return new Error("Robinhood is unreachable right now. Try again shortly, or check the link in Settings.");
}

async function callRobinhoodTool(name: string, input: unknown): Promise<unknown> {
  let mcpClient: Client;
  try {
    mcpClient = await ensureClient();
  } catch (err) {
    throw translateConnectionError(err);
  }
  let result;
  try {
    result = await mcpClient.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
  } catch (err) {
    // One reconnect attempt covers dropped sessions and expired access
    // tokens (the transport refreshes tokens on connect). The stale client
    // is closed, not abandoned, so its transport cannot linger.
    if (client === mcpClient) client = null;
    void mcpClient.close().catch(() => undefined);
    try {
      mcpClient = await ensureClient();
      result = await mcpClient.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
    } catch (retryErr) {
      throw translateConnectionError(retryErr);
    }
  }
  const text = textFromContent(result.content);
  if (result.isError) {
    throw new Error(text || `Robinhood tool ${name} failed.`);
  }
  return result.structuredContent ?? text;
}

/**
 * Connects, records the live tool list, and registers allowlisted read
 * tools at the portfolio_read tier. The full discovery snapshot is written
 * to server/data (gitignored) for inspection.
 */
export async function connectAndRegisterTools(): Promise<string[]> {
  const startedGeneration = generation;
  const mcpClient = await ensureClient();
  const discovered = await mcpClient.listTools();
  if (startedGeneration !== generation) {
    // Unlinked while discovery was in flight; register nothing.
    return [];
  }

  const snapshotPath = path.join(config.dataDir, "robinhood-mcp-tools.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(discovered.tools, null, 2));
  console.log(
    `Robinhood MCP exposes ${discovered.tools.length} tools: ${discovered.tools.map((t) => t.name).join(", ")}`,
  );
  console.log(`Full schemas recorded at ${snapshotPath}`);

  // Clear the prior registration first, then record what this connect saw;
  // unregisterRobinhoodTools also resets the available-tools set.
  unregisterRobinhoodTools();
  availableToolNames = new Set(discovered.tools.map((tool) => tool.name));
  for (const tool of discovered.tools) {
    const tier = TOOL_TIERS[tool.name];
    if (!tier) continue;
    registerTool({
      name: tool.name,
      tier,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema as Anthropic.Tool.InputSchema,
      execute: async (input) => ({ forModel: await callRobinhoodTool(tool.name, input) }),
    });
    registeredToolNames.push(tool.name);
  }
  console.log(`Registered ${registeredToolNames.length} Robinhood tools: ${registeredToolNames.join(", ")}`);
  return registeredToolNames;
}

function stringifyAck(ack: unknown): string {
  return typeof ack === "string" ? ack : JSON.stringify(ack);
}

/**
 * THE ONLY PATH to a Robinhood execution tool. It accepts nothing but a
 * stored pending order in confirmed status; parameters are taken from that
 * row and never from model output. Do not add another caller besides the
 * confirmation gate, and do not add a bypass.
 *
 * Argument names (symbol, side, order_type, order_id) are provisional until
 * validated against a real Robinhood link; a mismatch fails loudly on the
 * confirmation card rather than placing anything wrong.
 */
export async function executeConfirmedOrder(order: PendingOrderView): Promise<string> {
  if (order.status !== "confirmed") {
    throw new Error(
      `Refusing to execute order ${order.id}: status is ${order.status}, not confirmed.`,
    );
  }

  if (order.action === "cancel") {
    if (!order.brokerRef) {
      throw new Error(`Cancel order ${order.id} has no broker order reference.`);
    }
    return stringifyAck(await callRobinhoodTool("cancel_equity_order", { order_id: order.brokerRef }));
  }

  const args: Record<string, unknown> = {
    symbol: order.ticker,
    side: order.side,
    quantity: order.quantity,
    order_type: order.orderType,
  };
  if (order.orderType === "limit" && order.limitPrice !== null) {
    args.limit_price = order.limitPrice;
  }

  // If the live MCP exposes a review tool, preview the order first. A review
  // failure aborts placement (the error surfaces on the card), so nothing is
  // sent that the broker flagged during review.
  let reviewNote = "";
  if (availableToolNames.has("review_equity_order")) {
    const review = await callRobinhoodTool("review_equity_order", args);
    reviewNote = ` Reviewed before placing: ${stringifyAck(review)}`;
  }

  const ack = stringifyAck(await callRobinhoodTool("place_equity_order", args));
  return `${ack}${reviewNote}`;
}

export function unregisterRobinhoodTools(): void {
  for (const name of registeredToolNames) {
    unregisterTool(name);
  }
  registeredToolNames = [];
  availableToolNames = new Set();
}

/**
 * Starts the link. If the server accepts the connection (valid stored
 * tokens, or a mock without auth), tools register immediately and no URL
 * is returned. On a 401 the transport runs the OAuth discovery flow and
 * the provider captures the authorization URL for the browser.
 */
export async function beginLink(): Promise<string> {
  oauthProvider.pendingAuthorizationUrl = null;
  // Fresh single-use state for every link attempt.
  oauthProvider.rotateState();
  try {
    await connectAndRegisterTools();
    return "";
  } catch (err) {
    // Assertion needed: the auth flow mutates the provider, which
    // TypeScript's narrowing of the assignment above cannot see.
    const authorizationUrl = oauthProvider.pendingAuthorizationUrl as URL | null;
    if (authorizationUrl) {
      return authorizationUrl.toString();
    }
    throw err;
  }
}

export async function finishLink(code: string): Promise<void> {
  const outcome = await auth(oauthProvider, {
    serverUrl: config.robinhoodMcpUrl,
    authorizationCode: code,
  });
  if (outcome !== "AUTHORIZED") {
    throw new Error("Robinhood token exchange did not complete.");
  }
  await connectAndRegisterTools();
}

export async function unlink(): Promise<void> {
  // Invalidate any connect still in flight before tearing down state, so a
  // late arrival cannot re-register tools after the user unlinked.
  generation += 1;
  unregisterRobinhoodTools();
  if (client) {
    await client.close().catch(() => undefined);
    client = null;
  }
  oauthProvider.clear();
}

export interface LinkStatus {
  /** Tokens are stored for the real Robinhood MCP. */
  linked: boolean;
  /** Tools are registered and callable right now. */
  active: boolean;
  tools: string[];
}

export function getLinkStatus(): LinkStatus {
  return {
    linked: oauthProvider.isLinked(),
    active: registeredToolNames.length > 0,
    tools: [...registeredToolNames],
  };
}

/** Reconnects a previously linked account at startup without blocking boot. */
export function resumeLinkIfPresent(): void {
  if (!oauthProvider.isLinked()) return;
  connectAndRegisterTools().catch((err) => {
    console.error("Robinhood MCP reconnect failed; relink from settings.", err);
  });
}
