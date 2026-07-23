import { Router } from "express";
import { isTierEnabled, setTierEnabled } from "../db/settings.js";
import { getAllTools } from "../tools/registry.js";
import type { ToolTier } from "../tools/registry.js";

export const settingsRouter = Router();

const TIERS: ToolTier[] = ["market_data", "portfolio_read", "execution"];

settingsRouter.get("/tools", (_req, res) => {
  const tools = getAllTools();
  res.json(
    TIERS.map((tier) => ({
      tier,
      enabled: isTierEnabled(tier),
      tools: tools.filter((tool) => tool.tier === tier).map((tool) => tool.name),
    })),
  );
});

settingsRouter.put("/tools", (req, res) => {
  const body = req.body as { tier?: unknown; enabled?: unknown } | undefined;
  const tier = body?.tier;
  if (typeof tier !== "string" || !(TIERS as string[]).includes(tier) || typeof body?.enabled !== "boolean") {
    res.status(400).json({ error: "Expected { tier, enabled } with a known tier and a boolean." });
    return;
  }
  setTierEnabled(tier as ToolTier, body.enabled);
  res.json({ tier, enabled: body.enabled });
});
