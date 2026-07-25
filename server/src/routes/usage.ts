import { Router } from "express";
import { getUsageTotals } from "../db/usage.js";

export const usageRouter = Router();

usageRouter.get("/", (_req, res) => {
  res.json(getUsageTotals());
});
