import type { KeyValidationResult } from "@nomo/shared";
import { config } from "../config.js";

const TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Validates an Anthropic API key with a models list call, which is free
 * and does not consume tokens.
 */
export async function validateAnthropicKey(key: string): Promise<KeyValidationResult> {
  try {
    const res = await fetchWithTimeout(`${config.anthropicBaseUrl}/v1/models?limit=1`, {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) {
      return { valid: false, error: "Anthropic rejected this API key." };
    }
    return { valid: false, error: `Anthropic API returned status ${res.status}.` };
  } catch {
    return { valid: false, error: "Could not reach the Anthropic API. Check your connection." };
  }
}

/**
 * Validates a Polygon API key with the market status endpoint, available
 * on the free tier.
 */
export async function validatePolygonKey(key: string): Promise<KeyValidationResult> {
  try {
    // The key goes in a header, not the query string, so it cannot end up
    // in URL based logs.
    const res = await fetchWithTimeout(`${config.polygonBaseUrl}/v1/marketstatus/now`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Polygon rejected this API key." };
    }
    return { valid: false, error: `Polygon API returned status ${res.status}.` };
  } catch {
    return { valid: false, error: "Could not reach the Polygon API. Check your connection." };
  }
}
