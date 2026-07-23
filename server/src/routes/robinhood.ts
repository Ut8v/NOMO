import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import {
  beginLink,
  finishLink,
  getLinkStatus,
  oauthProvider,
  unlink,
} from "../services/robinhoodMcp.js";

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

robinhoodRouter.post("/unlink", async (_req, res) => {
  try {
    await unlink();
    res.json({ linked: false });
  } catch (err) {
    console.error("Robinhood unlink failed:", err);
    res.status(500).json({ error: "Unlink failed. Check the server logs." });
  }
});
