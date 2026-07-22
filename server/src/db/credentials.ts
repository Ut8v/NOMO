import { getDb } from "./index.js";

export type Provider = "anthropic" | "polygon";

export function setCredential(provider: Provider, secret: string): void {
  getDb()
    .prepare(
      `INSERT INTO credentials (provider, secret) VALUES (?, ?)
       ON CONFLICT (provider) DO UPDATE SET
         secret = excluded.secret,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(provider, secret);
}

export function getCredential(provider: Provider): string | null {
  const row = getDb()
    .prepare("SELECT secret FROM credentials WHERE provider = ?")
    .get(provider) as { secret: string } | undefined;
  return row ? row.secret : null;
}

export function hasCredential(provider: Provider): boolean {
  return getCredential(provider) !== null;
}
