import Anthropic from "@anthropic-ai/sdk";
import { getCredential } from "../db/credentials.js";
import { config } from "../config.js";
import { ChatError, MISSING_API_KEY } from "./chatError.js";

/**
 * Single place the server constructs an Anthropic client and chooses a model.
 * The chat loop, specialists, synthesis, and the skeptic all go through here so
 * model tiering (cheap specialists, strong synthesis) stays consistent and the
 * stored key is read in exactly one way.
 */
export function createAnthropicClient(): Anthropic {
  const apiKey = getCredential("anthropic");
  if (!apiKey) {
    throw new ChatError(MISSING_API_KEY.code, MISSING_API_KEY.message);
  }
  return new Anthropic({ apiKey });
}

/** The stronger model: main chat loop, synthesis, and the risk skeptic. */
export function strongModel(): string {
  return config.anthropicModel;
}

/** The cheaper model the research specialists run on. */
export function specialistModel(): string {
  return config.anthropicSpecialistModel;
}
