import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { PendingOrderView } from "@nomo/shared";
import type { BrokerReview } from "@nomo/shared";
import { config } from "../config.js";
import { recordToolCall } from "../db/auditLog.js";
import { getRobinhoodAccountNumber } from "../db/settings.js";
import { registerTool, unregisterTool } from "../tools/registry.js";
import { parseBrokerReview } from "./brokerReview.js";
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

/** A broker-level tool failure (isError result), as opposed to a transport drop. */
class RobinhoodToolError extends Error {}

// Backoff before the 2nd and 3rd attempts. Transient session drops usually
// recover on the very next connect, so the waits stay short.
const RETRY_BACKOFF_MS = [200, 700];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Only transient failures are worth retrying. An expired session needs a
 * relink, and a 4xx is a client error that will not change on retry, so both
 * are left to fail; connection drops and 5xx errors are retried.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (/\b4\d\d\b/.test(message)) return false;
  return true;
}

async function callRobinhoodTool(name: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, unknown>;
  for (let attempt = 0; ; attempt++) {
    let mcpClient: Client;
    try {
      mcpClient = await ensureClient();
    } catch (err) {
      if (attempt < RETRY_BACKOFF_MS.length && isRetryable(err)) {
        await delay(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      throw translateConnectionError(err);
    }

    try {
      const result = await mcpClient.callTool({ name, arguments: args });
      const text = textFromContent(result.content);
      if (result.isError) {
        // A broker-level "no" (bad arg, insufficient funds); do not retry it.
        throw new RobinhoodToolError(text || `Robinhood tool ${name} failed.`);
      }
      return result.structuredContent ?? text;
    } catch (err) {
      if (err instanceof RobinhoodToolError) throw err;
      // Transport failure: drop the stale client so the next attempt reconnects.
      if (client === mcpClient) client = null;
      void mcpClient.close().catch(() => undefined);
      if (attempt < RETRY_BACKOFF_MS.length && isRetryable(err)) {
        await delay(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      throw translateConnectionError(err);
    }
  }
}

const ACCOUNT_FIELD = "account_number";

/**
 * Hides account numbers from anything returned to the model: any account_number
 * field, and any occurrence of the stored account number's exact value. This is
 * why the account number can never surface in a chat, even though the broker
 * echoes it in order and position payloads.
 */
export function scrubAccountNumbers(value: unknown, known: string | null): unknown {
  if (typeof value === "string") {
    return known && value.includes(known) ? value.split(known).join("[hidden]") : value;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubAccountNumbers(entry, known));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === ACCOUNT_FIELD ? "[hidden]" : scrubAccountNumbers(val, known);
    }
    return out;
  }
  return value;
}

/**
 * Removes account_number from a tool's input schema so the model never sees it
 * as a parameter and cannot supply one. Returns whether the tool required it,
 * which decides if the stored account is injected server-side at call time.
 */
export function stripAccountFromSchema(
  schema: Anthropic.Tool.InputSchema,
): { schema: Anthropic.Tool.InputSchema; requiresAccount: boolean } {
  const clone = JSON.parse(JSON.stringify(schema ?? { type: "object" })) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const requiresAccount = Array.isArray(clone.required) && clone.required.includes(ACCOUNT_FIELD);
  if (clone.properties) delete clone.properties[ACCOUNT_FIELD];
  if (Array.isArray(clone.required)) clone.required = clone.required.filter((r) => r !== ACCOUNT_FIELD);
  return { schema: clone as Anthropic.Tool.InputSchema, requiresAccount };
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
    const { schema, requiresAccount } = stripAccountFromSchema(tool.inputSchema as Anthropic.Tool.InputSchema);
    registerTool({
      name: tool.name,
      tier,
      description: tool.description ?? tool.name,
      inputSchema: schema,
      execute: async (input) => {
        const args: Record<string, unknown> = { ...((input ?? {}) as Record<string, unknown>) };
        const account = getRobinhoodAccountNumber();
        // The account is injected here, never taken from the model. If a tool
        // needs one and none is chosen, say so rather than guessing an account.
        if (requiresAccount) {
          if (!account) {
            return {
              forModel: {
                error: "No trading account is selected. Ask the user to choose one in Settings before reading account data.",
              },
            };
          }
          args[ACCOUNT_FIELD] = account;
        }
        const raw = await callRobinhoodTool(tool.name, args);
        return { forModel: scrubAccountNumbers(raw, account) };
      },
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
 * Maps a stored order to Robinhood's place/review argument shape. The broker
 * parameter is `type` (market, limit, stop_market, stop_limit); limit_price is
 * sent for limit and stop_limit, stop_price for stop_market and stop_limit.
 * Note: account_number is required by the live schema for real placement and is
 * not yet wired here; the mock does not require it. That remains part of the
 * one manual real-account verification step.
 */
function buildOrderArgs(order: {
  ticker: string;
  side: string | null;
  quantity: string | null;
  dollarAmount?: string | null;
  orderType: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  accountNumber: string;
  refId?: string;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    account_number: order.accountNumber,
    symbol: order.ticker,
    side: order.side,
    type: order.orderType,
  };
  // Sized by a dollar notional (market only) or by share quantity, never both.
  if (order.dollarAmount != null) {
    args.dollar_amount = order.dollarAmount;
  } else {
    args.quantity = order.quantity;
  }
  const type = order.orderType;
  if ((type === "limit" || type === "stop_limit") && order.limitPrice != null) {
    args.limit_price = order.limitPrice;
  }
  if ((type === "stop_market" || type === "stop_limit") && order.stopPrice != null) {
    args.stop_price = order.stopPrice;
  }
  // Idempotency key: reuse the pending order's UUID so a transport retry of the
  // same logical order deduplicates at the broker.
  if (order.refId) {
    args.ref_id = order.refId;
  }
  return args;
}

/**
 * The user-selected account orders are placed against. It is required by the
 * broker and is never guessed here: if it has not been set from the UI, the
 * order fails loudly rather than defaulting to some account.
 */
function requireAccountNumber(): string {
  const account = getRobinhoodAccountNumber();
  if (!account) {
    throw new Error(
      "No Robinhood account is selected. Open Settings and choose the account to trade before placing or simulating orders.",
    );
  }
  return account;
}

/** Lists the linked account numbers for the settings picker (never auto-selected). */
export async function listAccounts(): Promise<unknown> {
  return callRobinhoodTool("get_accounts", {});
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

  const account = requireAccountNumber();
  const args = buildOrderArgs({
    ticker: order.ticker,
    side: order.side,
    quantity: order.quantity,
    dollarAmount: order.dollarAmount,
    orderType: order.orderType,
    limitPrice: order.limitPrice,
    stopPrice: order.stopPrice,
    accountNumber: account,
    refId: order.id,
  });

  // If the live MCP exposes a review tool, preview the order first. A review
  // failure aborts placement (the error surfaces on the card), so nothing is
  // sent that the broker flagged during review.
  let reviewNote = "";
  if (availableToolNames.has("review_equity_order")) {
    const review = parseBrokerReview(await callRobinhoodTool("review_equity_order", args));
    const notes = [...review.alerts, review.summary].filter(Boolean);
    if (notes.length > 0) reviewNote = ` Reviewed before placing: ${notes.join(" ")}`;
  }

  // Scrub the account number from the broker ack before it is stored on the
  // order and shown in the app.
  const ack = stringifyAck(scrubAccountNumbers(await callRobinhoodTool("place_equity_order", args), account));
  return `${ack}${reviewNote}`;
}

/**
 * Deterministic pre-trade simulation for the synthesis step. It previews an
 * equity order via Robinhood's review tool and returns the warnings text; it
 * places nothing. Called straight through the provider, not the registry, so a
 * disabled tier cannot skip the mandatory simulation. Throws when review is
 * unavailable, which the orchestrator surfaces as "no proposal created".
 */
export async function simulateEquityOrder(proposal: {
  ticker: string;
  side: string;
  quantity: string;
  orderType: string;
  limitPrice?: string | null;
  stopPrice?: string | null;
}): Promise<BrokerReview> {
  const args = buildOrderArgs({
    ticker: proposal.ticker,
    side: proposal.side,
    quantity: proposal.quantity,
    orderType: proposal.orderType,
    limitPrice: proposal.limitPrice ?? null,
    stopPrice: proposal.stopPrice ?? null,
    accountNumber: requireAccountNumber(),
  });

  // This previews a live order at the broker on synthesis's behalf, so it is
  // audited like every other tool call, tagged to the synthesis agent.
  if (!availableToolNames.has("review_equity_order")) {
    recordToolCall({ toolName: "review_equity_order", tier: "portfolio_read", params: args, outcome: "unavailable: not linked", agent: "synthesis" });
    throw new Error(
      "Order simulation is unavailable: Robinhood is not linked or does not expose review_equity_order.",
    );
  }
  try {
    const review = parseBrokerReview(await callRobinhoodTool("review_equity_order", args));
    recordToolCall({ toolName: "review_equity_order", tier: "portfolio_read", params: args, outcome: "ok", agent: "synthesis" });
    return review;
  } catch (err) {
    const message = err instanceof Error ? err.message : "review failed";
    recordToolCall({ toolName: "review_equity_order", tier: "portfolio_read", params: args, outcome: `error: ${message}`, agent: "synthesis" });
    throw err;
  }
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
