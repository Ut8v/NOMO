import { Router } from "express";
import type { StoredMessage } from "@nomo/shared";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  replaceMessages,
} from "../db/conversations.js";

export const conversationsRouter = Router();

const MAX_MESSAGES = 2000;

function parseMessages(body: unknown): StoredMessage[] | null {
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) return null;
  for (const message of messages) {
    const role = (message as { role?: unknown })?.role;
    const blocks = (message as { blocks?: unknown })?.blocks;
    if ((role !== "user" && role !== "assistant") || !Array.isArray(blocks)) {
      return null;
    }
  }
  return messages as StoredMessage[];
}

conversationsRouter.get("/", (_req, res) => {
  res.json({ conversations: listConversations() });
});

conversationsRouter.post("/", (req, res) => {
  const title = typeof (req.body as { title?: unknown })?.title === "string" ? (req.body as { title: string }).title : "";
  res.status(201).json({ conversation: createConversation(title) });
});

conversationsRouter.get("/:id", (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: "No such conversation." });
    return;
  }
  res.json({ conversation });
});

conversationsRouter.put("/:id/messages", (req, res) => {
  const messages = parseMessages(req.body);
  if (!messages) {
    res.status(400).json({ error: "messages must be an array of user and assistant turns with block arrays." });
    return;
  }
  if (!replaceMessages(req.params.id, messages)) {
    res.status(404).json({ error: "No such conversation." });
    return;
  }
  res.json({ ok: true });
});

conversationsRouter.delete("/:id", (req, res) => {
  const removed = deleteConversation(req.params.id);
  if (!removed) {
    res.status(404).json({ error: "No such conversation." });
    return;
  }
  res.json({ ok: true });
});
