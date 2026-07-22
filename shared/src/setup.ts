/**
 * Types for the first-run setup flow, shared between server and frontend.
 */

export interface SetupStatus {
  /** True once every required credential is stored. */
  configured: boolean;
  /** Per-provider breakdown so the setup screen can show progress. */
  providers: {
    anthropic: boolean;
    polygon: boolean;
  };
}

export interface SaveKeysRequest {
  anthropicApiKey: string;
  polygonApiKey: string;
}

export interface KeyValidationResult {
  valid: boolean;
  /** Human-readable reason when validation fails. */
  error?: string;
}

export interface SaveKeysResponse {
  saved: boolean;
  anthropic: KeyValidationResult;
  polygon: KeyValidationResult;
}

export interface ApiError {
  error: string;
}
