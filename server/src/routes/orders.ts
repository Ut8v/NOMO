import { Router } from "express";
import { confirmOrder, getOrder, rejectOrder } from "../services/executionGate.js";
import { ClosePositionError, proposeClosePosition } from "../services/portfolio.js";

export const ordersRouter = Router();

// One-click close from the portfolio view. This only creates a pending
// order; the user still confirms or rejects it like any other proposal.
ordersRouter.post("/close-position", async (req, res) => {
  const ticker = (req.body as { ticker?: unknown } | undefined)?.ticker;
  try {
    const order = await proposeClosePosition(ticker);
    res.json({ order });
  } catch (err) {
    if (err instanceof ClosePositionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "The close proposal failed.";
    console.error("Close-position proposal failed:", err);
    res.status(502).json({ error: message });
  }
});

ordersRouter.get("/:id", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: "No such order." });
    return;
  }
  res.json({ order });
});

ordersRouter.post("/:id/confirm", async (req, res) => {
  try {
    const result = await confirmOrder(req.params.id);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : 409;
      res.status(status).json({ error: "The order cannot be confirmed.", order: result.order });
      return;
    }
    res.json({ order: result.order });
  } catch (err) {
    console.error("Order confirmation failed:", err);
    res.status(500).json({ error: "Confirmation failed on the server. Check the logs." });
  }
});

ordersRouter.post("/:id/reject", (req, res) => {
  const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === "string"
    ? (req.body as { reason: string }).reason
    : undefined;
  const result = rejectOrder(req.params.id, reason);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 409;
    res.status(status).json({ error: "The order cannot be rejected.", order: result.order });
    return;
  }
  res.json({ order: result.order });
});
