import { getDb } from "./index.js";

/**
 * Read-only introspection for the local database dashboard. Everything here is
 * SELECT only. Secrets never leave SQLite: any redacted column is replaced with
 * a literal in the query itself, so the real value is never read into memory.
 *
 * Every provider secret (Anthropic, Polygon, and all Robinhood OAuth tokens)
 * lives in credentials.secret, so redacting that one column name covers them.
 */

const REDACT_COLUMNS = new Set(["secret"]);
const REDACTED = "[redacted]";
const MAX_LIMIT = 200;

export interface TableSummary {
  name: string;
  rowCount: number;
}

export interface TablePage {
  name: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

function quoteId(id: string): string {
  // Identifiers here always come from sqlite_master or PRAGMA, never user
  // input, but quote-escape anyway so a table with a quote cannot break out.
  return `"${id.replace(/"/g, '""')}"`;
}

/** Browsable tables: real tables only, excluding sqlite internals and the FTS shadow tables. */
export function listBrowsableTables(): TableSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%fts%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  return rows.map((row) => {
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM ${quoteId(row.name)}`).get() as { n: number };
    return { name: row.name, rowCount: count.n };
  });
}

function browsableTableNames(): Set<string> {
  return new Set(listBrowsableTables().map((t) => t.name));
}

function columnNames(table: string): string[] {
  const info = getDb().prepare(`PRAGMA table_info(${quoteId(table)})`).all() as Array<{ name: string }>;
  return info.map((column) => column.name);
}

/**
 * A page of rows from one browsable table, newest first, with secrets redacted.
 * Throws if the table is not browsable, so the route rejects unknown or FTS
 * shadow tables rather than reading them.
 */
export function getTablePage(name: string, limit = 50, offset = 0): TablePage {
  if (!browsableTableNames().has(name)) {
    throw new Error(`Unknown or non-browsable table: ${name}`);
  }
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_LIMIT);
  const safeOffset = Math.max(0, Math.floor(offset) || 0);

  const columns = columnNames(name);
  const selectList = columns
    .map((column) =>
      REDACT_COLUMNS.has(column) ? `'${REDACTED}' AS ${quoteId(column)}` : quoteId(column),
    )
    .join(", ");

  const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM ${quoteId(name)}`).get() as { n: number }).n;

  // Newest first via rowid; every browsable table has a rowid.
  const rows = getDb()
    .prepare(`SELECT ${selectList} FROM ${quoteId(name)} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
    .all(safeLimit, safeOffset) as Array<Record<string, unknown>>;

  return { name, columns, rows, total, limit: safeLimit, offset: safeOffset };
}
