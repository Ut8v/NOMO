import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { registerTool, unregisterTool } from "../tools/registry.js";
import { RobinhoodOAuthProvider } from "./robinhoodAuth.js";

/**
 * Read-only allowlist. Only tools named here AND present in the live
 * tools/list response are registered, always at the portfolio_read tier.
 * Execution tools (review, place, cancel) are deliberately absent and must
 * not be added in this phase.
 */
const READ_TOOL_ALLOWLIST = new Set([
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_orders",
  "get_equity_quotes",
  "get_equity_tradability",
  "search",
]);

export const oauthProvider = new RobinhoodOAuthProvider();

let client: Client | null = null;
let connecting: Promise<Client> | null = null;
let registeredToolNames: string[] = [];

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
    connecting = connect()
      .then((c) => {
        client = c;
        c.onclose = () => {
          client = null;
        };
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

async function callRobinhoodTool(name: string, input: unknown): Promise<unknown> {
  let mcpClient = await ensureClient();
  let result;
  try {
    result = await mcpClient.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
  } catch (err) {
    // One reconnect attempt covers dropped sessions and expired access
    // tokens (the transport refreshes tokens on connect).
    client = null;
    mcpClient = await ensureClient();
    result = await mcpClient.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
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
  const mcpClient = await ensureClient();
  const discovered = await mcpClient.listTools();

  const snapshotPath = path.join(config.dataDir, "robinhood-mcp-tools.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(discovered.tools, null, 2));
  console.log(
    `Robinhood MCP exposes ${discovered.tools.length} tools: ${discovered.tools.map((t) => t.name).join(", ")}`,
  );
  console.log(`Full schemas recorded at ${snapshotPath}`);

  unregisterRobinhoodTools();
  for (const tool of discovered.tools) {
    if (!READ_TOOL_ALLOWLIST.has(tool.name)) continue;
    registerTool({
      name: tool.name,
      tier: "portfolio_read",
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema as Anthropic.Tool.InputSchema,
      execute: async (input) => ({ forModel: await callRobinhoodTool(tool.name, input) }),
    });
    registeredToolNames.push(tool.name);
  }
  console.log(`Registered ${registeredToolNames.length} Robinhood read tools at portfolio_read tier.`);
  return registeredToolNames;
}

export function unregisterRobinhoodTools(): void {
  for (const name of registeredToolNames) {
    unregisterTool(name);
  }
  registeredToolNames = [];
}

/**
 * Starts the link. If the server accepts the connection (valid stored
 * tokens, or a mock without auth), tools register immediately and no URL
 * is returned. On a 401 the transport runs the OAuth discovery flow and
 * the provider captures the authorization URL for the browser.
 */
export async function beginLink(): Promise<string> {
  oauthProvider.pendingAuthorizationUrl = null;
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
  unregisterRobinhoodTools();
  if (client) {
    await client.close().catch(() => undefined);
    client = null;
  }
  oauthProvider.clear();
}

export function getLinkStatus(): { linked: boolean; tools: string[] } {
  // Tokens prove a real Robinhood link; registered tools also count so a
  // no-auth mock server reports linked during tests.
  return {
    linked: oauthProvider.isLinked() || registeredToolNames.length > 0,
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
