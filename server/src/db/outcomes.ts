import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";

export interface OutcomeRecord {
  id: string;
  pendingOrderId: string;
  symbol: string;
  tags: string[];
  realizedPl: number;
  recordedAt: string;
}

interface OutcomeRow {
  id: string;
  pending_order_id: string;
  symbol: string;
  tags: string;
  realized_pl: number;
  recorded_at: string;
}

function toRecord(row: OutcomeRow): OutcomeRecord {
  return {
    id: row.id,
    pendingOrderId: row.pending_order_id,
    symbol: row.symbol,
    tags: JSON.parse(row.tags) as string[],
    realizedPl: row.realized_pl,
    recordedAt: row.recorded_at,
  };
}

export interface NewOutcome {
  pendingOrderId: string;
  symbol: string;
  tags: string[];
  realizedPl: number;
}

export function insertOutcome(outcome: NewOutcome): OutcomeRecord {
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO outcomes (id, pending_order_id, symbol, tags, realized_pl) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, outcome.pendingOrderId, outcome.symbol, JSON.stringify(outcome.tags), outcome.realizedPl);
  const row = getDb().prepare("SELECT * FROM outcomes WHERE id = ?").get(id) as OutcomeRow;
  return toRecord(row);
}

export function listOutcomes(): OutcomeRecord[] {
  const rows = getDb().prepare("SELECT * FROM outcomes ORDER BY recorded_at DESC, rowid DESC").all() as OutcomeRow[];
  return rows.map(toRecord);
}
