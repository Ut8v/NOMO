import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import {
  beginLink,
  finishLink,
  getLinkStatus,
  listAccounts,
  oauthProvider,
  unlink,
} from "../services/robinhoodMcp.js";
import { getRobinhoodAccountNumber, setRobinhoodAccountNumber } from "../db/settings.js";
import { listOpenOrders, listPositions } from "../services/portfolio.js";

// Robinhood account numbers are short identifiers; keep validation permissive
// but bounded so a stored value cannot be absurd.
const ACCOUNT_PATTERN = /^[A-Za-z0-9-]{1,40}$/;

function stateMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const robinhoodRouter = Router();

robinhoodRouter.get("/status", (_req, res) => {
  res.json(getLinkStatus());
});

robinhoodRouter.post("/link", async (_req, res) => {
  try {
    const authorizeUrl = await beginLink();
    // An empty URL means existing tokens were still valid and the link
    // completed without user interaction.
    res.json({ authorizeUrl, linked: authorizeUrl === "" });
  } catch (err) {
    console.error("Robinhood link failed to start:", err);
    res.status(502).json({ error: "Could not start the Robinhood link flow. Check the server logs." });
  }
});

robinhoodRouter.get("/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const expected = oauthProvider.expectedState();

  const page = (title: string, body: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body style="font-family: sans-serif; padding: 2rem;"><h2>${title}</h2><p>${body}</p></body></html>`;

  if (!code) {
    res.status(400).send(page("Robinhood link failed", "No authorization code was returned. Close this tab and try again."));
    return;
  }
  // This is an unauthenticated localhost GET that any web page could fire,
  // so the state check must fail closed: no stored state means no link was
  // started here, and the callback is rejected.
  if (!expected || !state || !stateMatches(state, expected)) {
    res.status(400).send(page("Robinhood link rejected", "State mismatch. Close this tab and restart the link from settings."));
    return;
  }

  try {
    await finishLink(code);
    res.send(page("Robinhood linked", "You can close this tab and return to NOMO."));
  } catch (err) {
    console.error("Robinhood link failed to finish:", err);
    res.status(502).send(page("Robinhood link failed", "Token exchange failed. Close this tab and retry from settings."));
  } finally {
    // State and verifier are single use regardless of outcome.
    oauthProvider.clearTransient();
  }
});

robinhoodRouter.get("/account", (_req, res) => {
  res.json({ accountNumber: getRobinhoodAccountNumber() });
});

robinhoodRouter.put("/account", (req, res) => {
  const raw = (req.body as { accountNumber?: unknown } | undefined)?.accountNumber;
  const accountNumber = typeof raw === "string" ? raw.trim() : "";
  if (!ACCOUNT_PATTERN.test(accountNumber)) {
    res.status(400).json({ error: "accountNumber must be a short alphanumeric account identifier." });
    return;
  }
  setRobinhoodAccountNumber(accountNumber);
  res.json({ accountNumber });
});

// Lists the linked accounts so the user can pick one in the UI. The agent never
// selects an account on its own; this is a UI-only aid.
robinhoodRouter.get("/accounts", async (_req, res) => {
  try {
    res.json({ accounts: await listAccounts() });
  } catch (err) {
    console.error("Failed to list Robinhood accounts:", err);
    res.status(502).json({ error: "Could not load accounts. Make sure Robinhood is linked." });
  }
});

// Open equity positions for the portfolio view. A UI-only read like
// /accounts; the response is already account-number scrubbed.
robinhoodRouter.get("/positions", async (_req, res) => {
  try {
    res.json({ positions: await listPositions() });
  } catch (err) {
    console.error("Failed to list equity positions:", err);
    res.status(502).json({ error: "Could not load positions. Make sure Robinhood is linked." });
  }
});

// Resting equity orders for the portfolio view's open-orders panel.
robinhoodRouter.get("/orders", async (_req, res) => {
  try {
    res.json({ orders: await listOpenOrders() });
  } catch (err) {
    console.error("Failed to list equity orders:", err);
    res.status(502).json({ error: "Could not load open orders. Make sure Robinhood is linked." });
  }
});

robinhoodRouter.post("/unlink", async (_req, res) => {
  try {
    await unlink();
    res.json({ linked: false });
  } catch (err) {
    console.error("Robinhood unlink failed:", err);
    res.status(500).json({ error: "Unlink failed. Check the server logs." });
  }
});
