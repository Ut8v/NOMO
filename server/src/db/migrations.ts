import type { Database } from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only list. Never edit an applied migration; add a new one.
 */
const migrations: Migration[] = [
  {
    id: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE credentials (
        provider TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE pending_orders (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity TEXT NOT NULL,
        order_type TEXT NOT NULL,
        limit_price TEXT,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
          CHECK (status IN ('awaiting_confirmation', 'confirmed', 'rejected', 'expired', 'executed', 'failed')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        tier TEXT NOT NULL,
        params TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => (row as { id: number }).id),
  );

  const insert = db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)");

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id, migration.name);
    })();
    console.log(`Applied migration ${migration.id}: ${migration.name}`);
  }
}
