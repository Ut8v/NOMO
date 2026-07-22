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

/** Stores all entries in one transaction so a partial write cannot occur. */
export function setCredentials(entries: Array<{ provider: Provider; secret: string }>): void {
  getDb().transaction(() => {
    for (const entry of entries) {
      setCredential(entry.provider, entry.secret);
    }
  })();
}

export function getCredential(provider: Provider): string | null {
  const row = getDb()
    .prepare("SELECT secret FROM credentials WHERE provider = ?")
    .get(provider) as { secret: string } | undefined;
  return row ? row.secret : null;
}

/** Existence check that avoids reading the secret itself. */
export function hasCredential(provider: Provider): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM credentials WHERE provider = ?")
    .get(provider);
  return row !== undefined;
}
