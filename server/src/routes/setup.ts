import { Router } from "express";
import type {
  SetupStatus,
  SaveKeysRequest,
  SaveKeysResponse,
} from "@nomo/shared";
import { hasCredential, setCredentials } from "../db/credentials.js";
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

// Express 4 does not forward async rejections to its error handling, so the
// whole handler is wrapped; a storage failure must not crash the server.
setupRouter.post("/keys", async (req, res) => {
  try {
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

    // Both keys are written in one transaction, and only when both validate,
    // so a half-configured state cannot occur.
    const saved = anthropic.valid && polygon.valid;
    if (saved) {
      setCredentials([
        { provider: "anthropic", secret: anthropicApiKey },
        { provider: "polygon", secret: polygonApiKey },
      ]);
    }

    const response: SaveKeysResponse = { saved, anthropic, polygon };
    res.status(saved ? 200 : 422).json(response);
  } catch (err) {
    console.error("Saving keys failed:", err);
    res.status(500).json({ error: "Saving keys failed on the server. Check the server logs." });
  }
});
