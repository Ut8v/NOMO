import { Router } from "express";
import { confirmOrder, getOrder, rejectOrder } from "../services/executionGate.js";

export const ordersRouter = Router();

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
  const result = rejectOrder(req.params.id);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 409;
    res.status(status).json({ error: "The order cannot be rejected.", order: result.order });
    return;
  }
  res.json({ order: result.order });
});
