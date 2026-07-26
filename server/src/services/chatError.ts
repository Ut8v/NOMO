import Anthropic from "@anthropic-ai/sdk";
import type { ChatErrorCode } from "@nomo/shared";

export class ChatError extends Error {
  constructor(
    public readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** Single source for the missing key error so route and service cannot drift. */
export const MISSING_API_KEY = {
  code: "missing_api_key",
  message: "No Anthropic API key is stored. Run setup first.",
} as const;

/** Maps SDK errors to a ChatError the stream can relay, preserving aborts. */
export function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) {
    return err;
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401) {
      return new ChatError(
        "invalid_api_key",
        "Anthropic rejected the stored API key. Update it in settings.",
      );
    }
    if (err.status === 429 || err.status === 529) {
      return new ChatError(
        "overloaded",
        "The Anthropic API is rate limited or overloaded right now. Try again shortly.",
      );
    }
    return new ChatError("stream_error", `Anthropic API error (${err.status ?? "network"}).`);
  }
  return new ChatError("stream_error", "The chat stream failed unexpectedly.");
}
