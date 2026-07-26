import { useCallback, useEffect, useMemo, useState } from "react";
import type { TablePage, TableSummary } from "@nomo/shared";
import { fetchDbTable, fetchDbTables } from "../api";

interface Props {
  onBack: () => void;
}

const PAGE_SIZE = 50;

// Longer text (JSON params, thesis, results) is truncated in the cell and shown
// in full on hover.
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function DatabaseView({ onBack }: Props) {
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetchDbTables()
      .then((list) => {
        setTables(list);
        const first = list[0];
        if (first) setActive((current) => current ?? first.name);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load tables."));
  }, []);

  const load = useCallback((name: string, nextOffset: number) => {
    setLoading(true);
    setError(null);
    fetchDbTable(name, PAGE_SIZE, nextOffset)
      .then((result) => {
        setPage(result);
        setOffset(result.offset);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load table."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (active) {
      setFilter("");
      load(active, 0);
    }
  }, [active, load]);

  const selectTable = (name: string) => {
    if (name !== active) setActive(name);
  };

  const refresh = () => {
    if (active) {
      void fetchDbTables().then(setTables).catch(() => undefined);
      load(active, offset);
    }
  };

  const visibleRows = useMemo(() => {
    if (!page) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return page.rows;
    return page.rows.filter((row) =>
      page.columns.some((column) => cellText(row[column]).toLowerCase().includes(needle)),
    );
  }, [page, filter]);

  const total = page?.total ?? 0;
  const shownFrom = total === 0 ? 0 : offset + 1;
  const shownTo = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="db-view">
      <header className="chat-header">
        <div className="chat-header-left">
          <button className="icon-button" onClick={onBack} aria-label="Back to chat" title="Back to chat">
            <BackIcon />
          </button>
          <span className="chat-title">Database</span>
        </div>
        <div className="chat-header-actions">
          <button className="link-button" onClick={refresh}>
            Refresh
          </button>
        </div>
      </header>

      <div className="db-body">
        <nav className="db-tables">
          {tables.map((table) => (
            <button
              key={table.name}
              className={`db-table-item ${table.name === active ? "db-table-item-active" : ""}`}
              onClick={() => selectTable(table.name)}
            >
              <span className="db-table-name">{table.name}</span>
              <span className="db-table-count">{table.rowCount}</span>
            </button>
          ))}
        </nav>

        <section className="db-content">
          {error && <p className="error-text">{error}</p>}
          {active && (
            <div className="db-toolbar">
              <input
                className="db-filter"
                type="text"
                placeholder={`Filter this page of ${active}`}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <span className="muted db-range">
                {total === 0 ? "no rows" : `${shownFrom}–${shownTo} of ${total}`}
              </span>
              <div className="db-pager">
                <button disabled={offset === 0 || loading} onClick={() => active && load(active, Math.max(0, offset - PAGE_SIZE))}>
                  Prev
                </button>
                <button
                  disabled={offset + PAGE_SIZE >= total || loading}
                  onClick={() => active && load(active, offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          )}

          <div className="db-table-scroll">
            {page && (
              <table className="db-grid">
                <thead>
                  <tr>
                    {page.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, index) => (
                    <tr key={index}>
                      {page.columns.map((column) => {
                        const text = cellText(row[column]);
                        return (
                          <td key={column} title={text}>
                            {text.length > 160 ? `${text.slice(0, 160)}…` : text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {visibleRows.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={page.columns.length}>
                        {loading ? "Loading…" : "No rows to show."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
