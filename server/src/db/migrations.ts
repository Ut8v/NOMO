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
  {
    id: 7,
    name: "outcomes",
    // Realized results of closed positions, linked to the confirmed order
    // that opened them. Used only for the review_performance track record.
    sql: `
      CREATE TABLE outcomes (
        id TEXT PRIMARY KEY,
        pending_order_id TEXT NOT NULL REFERENCES pending_orders(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        tags TEXT NOT NULL,
        realized_pl REAL NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    id: 8,
    name: "messages-fts",
    // Full text index over message text for the search_history tool. Kept in
    // sync by the conversation write path; backfilled once at startup.
    sql: `
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        conversation_id UNINDEXED,
        tokenize = 'porter'
      );
    `,
  },
  {
    id: 9,
    name: "usage-events",
    // One row per assistant turn, recording token usage and estimated cost
    // so the UI can display Anthropic API spend.
    sql: `
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    id: 10,
    name: "audit-log-agent",
    // Names the sub-agent that made a tool call during orchestrated research,
    // NULL for the main chat loop and every pre-Phase-8 row.
    sql: `
      ALTER TABLE audit_log ADD COLUMN agent TEXT;
    `,
  },
  {
    id: 11,
    name: "usage-events-agent",
    // Attributes token spend to a sub-agent so per-agent cost can be reported.
    sql: `
      ALTER TABLE usage_events ADD COLUMN agent TEXT;
    `,
  },
  {
    id: 12,
    name: "pending-order-research-context",
    // Orchestrated proposals carry the synthesis thesis, the skeptic's bear
    // case, and Robinhood's pre-trade warnings from the mandatory simulation.
    // All NULL for directly proposed orders, which is why they are added, not
    // required. The confirmation gate never reads these columns.
    sql: `
      ALTER TABLE pending_orders ADD COLUMN thesis TEXT;
      ALTER TABLE pending_orders ADD COLUMN bear_case TEXT;
      ALTER TABLE pending_orders ADD COLUMN broker_warnings TEXT;
    `,
  },
  {
    id: 13,
    name: "pending-order-stop-price",
    // Stop trigger price for stop_market and stop_limit orders. NULL for
    // market and limit orders and every pre-existing row.
    sql: `
      ALTER TABLE pending_orders ADD COLUMN stop_price TEXT;
    `,
  },
  {
    id: 14,
    name: "pending-order-dollar-amount",
    // USD notional for a dollar-based market order. NULL when the order is
    // priced by share quantity, which is every pre-existing row.
    sql: `
      ALTER TABLE pending_orders ADD COLUMN dollar_amount TEXT;
    `,
  },
  {
    id: 15,
    name: "edgar-cache",
    // SEC EDGAR responses cached by endpoint + identifier. Filings change
    // slowly, so serving from here keeps NOMO well under SEC's rate cap. The
    // per-endpoint TTL is enforced in code against fetched_at.
    sql: `
      CREATE TABLE edgar_cache (
        endpoint TEXT NOT NULL,
        identifier TEXT NOT NULL,
        body TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (endpoint, identifier)
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
