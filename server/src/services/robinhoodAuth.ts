import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db/index.js";

/**
 * OAuth state for the Robinhood MCP, persisted in the credentials table so
 * a link survives server restarts. Robinhood uses authorization code with
 * PKCE, dynamic client registration, and refresh tokens (verified against
 * the live authorization server metadata).
 */

const KEYS = {
  tokens: "robinhood_tokens",
  client: "robinhood_client",
  verifier: "robinhood_verifier",
  state: "robinhood_state",
} as const;

function read(key: string): string | null {
  const row = getDb().prepare("SELECT secret FROM credentials WHERE provider = ?").get(key) as
    | { secret: string }
    | undefined;
  return row ? row.secret : null;
}

function write(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO credentials (provider, secret) VALUES (?, ?)
       ON CONFLICT (provider) DO UPDATE SET
         secret = excluded.secret,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(key, value);
}

function remove(key: string): void {
  getDb().prepare("DELETE FROM credentials WHERE provider = ?").run(key);
}

export class RobinhoodOAuthProvider implements OAuthClientProvider {
  /** Captured during the auth flow instead of redirecting a browser. */
  pendingAuthorizationUrl: URL | null = null;

  get redirectUrl(): string {
    return `http://${config.host}:${config.port}/api/robinhood/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "NOMO local instance",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    let value = read(KEYS.state);
    if (!value) {
      value = randomBytes(16).toString("hex");
      write(KEYS.state, value);
    }
    return value;
  }

  expectedState(): string | null {
    return read(KEYS.state);
  }

  clientInformation(): OAuthClientInformation | undefined {
    const raw = read(KEYS.client);
    return raw ? (JSON.parse(raw) as OAuthClientInformation) : undefined;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    write(KEYS.client, JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    const raw = read(KEYS.tokens);
    return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    write(KEYS.tokens, JSON.stringify(tokens));
  }

  redirectToAuthorization(url: URL): void {
    this.pendingAuthorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    write(KEYS.verifier, verifier);
  }

  codeVerifier(): string {
    const verifier = read(KEYS.verifier);
    if (!verifier) {
      throw new Error("No PKCE verifier stored; restart the Robinhood link flow.");
    }
    return verifier;
  }

  isLinked(): boolean {
    return read(KEYS.tokens) !== null;
  }

  clear(): void {
    remove(KEYS.tokens);
    remove(KEYS.client);
    remove(KEYS.verifier);
    remove(KEYS.state);
  }
}
