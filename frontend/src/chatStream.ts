import type { ChartSpec, ChatRequest, ChatStreamEvent } from "@nomo/shared";

export interface ChatStreamHandlers {
  onText: (text: string) => void;
  onChart: (spec: ChartSpec) => void;
  onError: (code: string, message: string) => void;
  onDone: () => void;
}

/**
 * POSTs the conversation and consumes the SSE response. EventSource only
 * supports GET, so the stream is parsed from fetch by hand.
 */
export async function streamChat(
  request: ChatRequest,
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (!signal.aborted) {
      handlers.onError("stream_error", "Could not reach the server.");
    }
    return;
  }

  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    handlers.onError(body?.code ?? "stream_error", body?.error ?? `Request failed (${res.status}).`);
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const dispatch = (event: ChatStreamEvent) => {
    if (finished) return;
    if (event.type === "text") {
      handlers.onText(event.text);
    } else if (event.type === "chart") {
      handlers.onChart(event.spec);
    } else if (event.type === "done") {
      finished = true;
      handlers.onDone();
    } else {
      finished = true;
      handlers.onError(event.code, event.message);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(line.slice(6)) as ChatStreamEvent;
          } catch {
            // One truncated frame must not mask real events still buffered,
            // like a final error event carrying an actionable code.
            continue;
          }
          dispatch(event);
        }
      }
    }
  } catch {
    if (signal.aborted) return;
    if (!finished) handlers.onError("stream_error", "The connection dropped mid-stream.");
    return;
  }

  // Stream ended without a done or error event, e.g. the server restarted.
  if (!finished && !signal.aborted) {
    handlers.onError("stream_error", "The stream ended unexpectedly.");
  }
}
