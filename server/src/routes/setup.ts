import { Router } from "express";
import type {
  SetupStatus,
  SaveKeysRequest,
  SaveKeysResponse,
} from "@nomo/shared";
import { hasCredential, setCredential } from "../db/credentials.js";
import { validateAnthropicKey, validatePolygonKey } from "../services/keyValidation.js";

export const setupRouter = Router();

setupRouter.get("/status", (_req, res) => {
  const anthropic = hasCredential("anthropic");
  const polygon = hasCredential("polygon");
  const status: SetupStatus = {
    configured: anthropic && polygon,
    providers: { anthropic, polygon },
  };
  res.json(status);
});

setupRouter.post("/keys", async (req, res) => {
  const body = req.body as Partial<SaveKeysRequest> | undefined;
  const anthropicApiKey = typeof body?.anthropicApiKey === "string" ? body.anthropicApiKey.trim() : "";
  const polygonApiKey = typeof body?.polygonApiKey === "string" ? body.polygonApiKey.trim() : "";

  if (!anthropicApiKey || !polygonApiKey) {
    res.status(400).json({ error: "Both anthropicApiKey and polygonApiKey are required." });
    return;
  }

  const [anthropic, polygon] = await Promise.all([
    validateAnthropicKey(anthropicApiKey),
    validatePolygonKey(polygonApiKey),
  ]);

  // Keys are stored only when both validate, so a half-configured state
  // cannot occur.
  const saved = anthropic.valid && polygon.valid;
  if (saved) {
    setCredential("anthropic", anthropicApiKey);
    setCredential("polygon", polygonApiKey);
  }

  const response: SaveKeysResponse = { saved, anthropic, polygon };
  res.status(saved ? 200 : 422).json(response);
});
