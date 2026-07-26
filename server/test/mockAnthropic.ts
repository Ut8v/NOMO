import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal mock of the Anthropic Messages streaming API for tests. It speaks
 * just enough SSE for the SDK's messages.stream().finalMessage() to reconstruct
 * an assistant message. A responder inspects each request body and returns the
 * content blocks to stream back, so tests can script multi-round tool use and
 * route by system prompt (which carries the agent name) under concurrency.
 */

export interface MockTextBlock {
  type: "text";
  text: string;
}
export interface MockToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export type MockContentBlock = MockTextBlock | MockToolUseBlock;

export interface MockAssistantReply {
  blocks: MockContentBlock[];
  /** Defaults to "tool_use" when any tool_use block is present, else "end_turn". */
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface AnthropicRequestBody {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
}

export type MockResponder = (body: AnthropicRequestBody) => MockAssistantReply;

export interface MockAnthropic {
  url: string;
  /** Every request body the SDK sent, in arrival order. */
  requests: AnthropicRequestBody[];
  close: () => Promise<void>;
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamReply(res: http.ServerResponse, model: string, reply: MockAssistantReply): void {
  const stopReason =
    reply.stopReason ?? (reply.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const usage = reply.usage ?? { input_tokens: 20, output_tokens: 10 };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    },
  });

  reply.blocks.forEach((block, index) => {
    if (block.type === "text") {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
    } else {
      sse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
    }
  });

  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

export async function startMockAnthropic(responder: MockResponder): Promise<MockAnthropic> {
  const requests: AnthropicRequestBody[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!req.url?.includes("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      let body: AnthropicRequestBody;
      try {
        body = JSON.parse(raw) as AnthropicRequestBody;
      } catch {
        res.writeHead(400).end();
        return;
      }
      requests.push(body);
      let reply: MockAssistantReply;
      try {
        reply = responder(body);
      } catch (err) {
        res.writeHead(500).end(String(err));
        return;
      }
      streamReply(res, body.model, reply);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
