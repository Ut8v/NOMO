import { Router } from "express";
import type { ChatMessage, ChatRequest, ChatStreamEvent } from "@nomo/shared";
import { MAX_CHAT_MESSAGES } from "@nomo/shared";
import { hasCredential } from "../db/credentials.js";
import { ChatError, MISSING_API_KEY, streamChatTurn } from "../services/chat.js";

export const chatRouter = Router();

function parseMessages(body: unknown): ChatMessage[] | null {
  const messages = (body as Partial<ChatRequest> | undefined)?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_CHAT_MESSAGES) {
    return null;
  }
  for (const entry of messages) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const message = entry as Partial<ChatMessage>;
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.length === 0
    ) {
      return null;
    }
  }
  return messages as ChatMessage[];
}

chatRouter.post("/", async (req, res) => {
  const messages = parseMessages(req.body);
  if (!messages) {
    res.status(400).json({ error: "messages must be a non-empty array of user and assistant turns." });
    return;
  }
  if (!hasCredential("anthropic")) {
    res.status(401).json({ error: MISSING_API_KEY.message, code: MISSING_API_KEY.code });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: ChatStreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Stop paying for tokens the moment the browser goes away.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    await streamChatTurn(
      messages,
      {
        onText: (text) => send({ type: "text", text }),
        onChart: (spec) => send({ type: "chart", spec }),
        onPendingOrder: (order) => send({ type: "pending_order", order }),
        onTool: (event) => send({ type: "tool", event }),
        onUsage: (usage) => send({ type: "usage", usage }),
      },
      abort.signal,
    );
    send({ type: "done" });
  } catch (err) {
    if (abort.signal.aborted) {
      // The client disconnected; nobody is listening for an error event.
    } else if (err instanceof ChatError) {
      send({ type: "error", code: err.code, message: err.message });
    } else {
      console.error("Chat stream failed:", err);
      send({ type: "error", code: "stream_error", message: "The chat stream failed unexpectedly." });
    }
  } finally {
    res.end();
  }
});
