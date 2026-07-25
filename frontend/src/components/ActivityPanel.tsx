import { useEffect, useState } from "react";

export interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "done" | "error";
}

const LABELS: Record<string, string> = {
  get_quote: "Fetching quote",
  get_ohlcv: "Fetching price history",
  render_chart: "Rendering chart",
  place_equity_order: "Preparing order",
  cancel_equity_order: "Preparing cancellation",
  remember: "Saving a memory",
  distill_lessons: "Distilling lessons",
  review_performance: "Reviewing performance",
  record_outcome: "Recording outcome",
  search_history: "Searching past chats",
};

function toolLabel(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, " ");
}

interface Props {
  activities: ToolActivity[];
  /** True while this turn is still streaming. */
  active: boolean;
}

export default function ActivityPanel({ activities, active }: Props) {
  const [expanded, setExpanded] = useState(true);

  // Collapse automatically once the turn finishes; the user can reopen it.
  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);

  const running = active && activities.some((a) => a.status === "running");
  const count = activities.length;
  const summary = running
    ? `Working (${count} tool${count === 1 ? "" : "s"})`
    : `Used ${count} tool${count === 1 ? "" : "s"}`;

  return (
    <div className="activity">
      <button className="activity-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`activity-chevron ${expanded ? "activity-chevron-open" : ""}`}>
          <ChevronIcon />
        </span>
        <span>{summary}</span>
      </button>
      {expanded && (
        <ul className="activity-list">
          {activities.map((activity) => {
            // A turn stopped mid-tool leaves a "running" item; show it as done
            // once the turn is no longer active so the spinner does not hang.
            const status = !active && activity.status === "running" ? "done" : activity.status;
            return (
              <li key={activity.id} className={`activity-item activity-${status}`}>
                <StatusIcon status={status} />
                <span className="activity-name" title={activity.name}>
                  {toolLabel(activity.name)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function StatusIcon({ status }: { status: ToolActivity["status"] }) {
  if (status === "running") return <span className="activity-spinner" aria-hidden="true" />;
  if (status === "error") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
