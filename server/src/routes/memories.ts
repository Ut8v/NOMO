import { Router } from "express";
import type { MemoryStatus } from "@nomo/shared";
import { deleteMemory, listMemories, updateMemory } from "../db/memories.js";
import { distillLessons } from "../services/distill.js";

export const memoriesRouter = Router();

const MAX_CONTENT_LENGTH = 500;

memoriesRouter.get("/", (_req, res) => {
  res.json({ memories: listMemories() });
});

memoriesRouter.put("/:id", (req, res) => {
  const body = req.body as { content?: unknown; status?: unknown; active?: unknown } | undefined;
  const patch: { content?: string; status?: MemoryStatus; active?: boolean } = {};

  if (body?.content !== undefined) {
    if (typeof body.content !== "string" || !body.content.trim()) {
      res.status(400).json({ error: "content must be a non-empty string." });
      return;
    }
    patch.content = body.content.trim().slice(0, MAX_CONTENT_LENGTH);
  }
  if (body?.status !== undefined) {
    if (body.status !== "approved" && body.status !== "pending") {
      res.status(400).json({ error: "status must be approved or pending." });
      return;
    }
    patch.status = body.status;
  }
  if (body?.active !== undefined) {
    if (typeof body.active !== "boolean") {
      res.status(400).json({ error: "active must be a boolean." });
      return;
    }
    patch.active = body.active;
  }

  const updated = updateMemory(req.params.id, patch);
  if (!updated) {
    res.status(404).json({ error: "No such memory." });
    return;
  }
  res.json({ memory: updated });
});

memoriesRouter.delete("/:id", (req, res) => {
  if (!deleteMemory(req.params.id)) {
    res.status(404).json({ error: "No such memory." });
    return;
  }
  res.json({ ok: true });
});

memoriesRouter.post("/distill", async (_req, res) => {
  try {
    res.json(await distillLessons());
  } catch (err) {
    console.error("Distillation failed:", err);
    res.status(502).json({ error: "Distillation failed. Check the server logs." });
  }
});
