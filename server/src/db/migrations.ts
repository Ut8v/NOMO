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
  {
    id: 2,
    name: "pending-order-result",
    sql: `
      ALTER TABLE pending_orders ADD COLUMN result TEXT;
    `,
  },
  {
    id: 3,
    name: "conversations",
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        blocks TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX idx_messages_conversation ON messages (conversation_id, seq);
    `,
  },
  {
    id: 4,
    name: "pending-order-actions",
    // Rebuild pending_orders so cancel proposals fit: an action column, an
    // optional broker order reference, and nullable place-only fields. No
    // table references pending_orders, so the rebuild is safe.
    sql: `
      CREATE TABLE pending_orders_new (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL DEFAULT 'place' CHECK (action IN ('place', 'cancel')),
        ticker TEXT NOT NULL,
        side TEXT CHECK (side IN ('buy', 'sell')),
        quantity TEXT,
        order_type TEXT,
        limit_price TEXT,
        broker_ref TEXT,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
          CHECK (status IN ('awaiting_confirmation', 'confirmed', 'rejected', 'expired', 'executed', 'failed')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        result TEXT
      );

      INSERT INTO pending_orders_new
        (id, action, ticker, side, quantity, order_type, limit_price, broker_ref, rationale, status, created_at, expires_at, resolved_at, result)
      SELECT
        id, 'place', ticker, side, quantity, order_type, limit_price, NULL, rationale, status, created_at, expires_at, resolved_at, result
      FROM pending_orders;

      DROP TABLE pending_orders;
      ALTER TABLE pending_orders_new RENAME TO pending_orders;
    `,
  },
  {
    id: 5,
    name: "memories",
    // Durable facts about the user as a trader. Injected into the system
    // prompt as read-only background only; never consulted by the gate.
    sql: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    id: 6,
    name: "pending-order-reject-reason",
    sql: `
      ALTER TABLE pending_orders ADD COLUMN reject_reason TEXT;
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
