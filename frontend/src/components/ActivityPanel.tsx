import { useEffect, useState } from "react";

export type ActivityStatus = "running" | "done" | "error";

export interface ToolActivity {
  id: string;
  name: string;
  status: ActivityStatus;
  /** Sub-agent lane this tool call belongs to, if any. */
  agent?: string;
}

export interface AgentActivity {
  name: string;
  status: ActivityStatus;
}

const LABELS: Record<string, string> = {
  get_quote: "Fetching quote",
  get_ohlcv: "Fetching price history",
  render_chart: "Rendering chart",
  place_equity_order: "Preparing order",
  cancel_equity_order: "Preparing cancellation",
  review_equity_order: "Simulating order",
  remember: "Saving a memory",
  distill_lessons: "Distilling lessons",
  review_performance: "Reviewing performance",
  record_outcome: "Recording outcome",
  search_history: "Searching past chats",
  deep_research: "Researching",
};

const AGENT_LABELS: Record<string, string> = {
  screener: "Screener",
  technicals: "Technicals",
  fundamentals: "Fundamentals & earnings",
  portfolio_risk: "Portfolio & risk",
  options: "Options",
  synthesis: "Synthesis",
  skeptic: "Risk skeptic",
};

function toolLabel(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, " ");
}

function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? name.replace(/_/g, " ");
}

interface Props {
  activities: ToolActivity[];
  agents: AgentActivity[];
  /** True while this turn is still streaming. */
  active: boolean;
}

export default function ActivityPanel({ activities, agents, active }: Props) {
  const [expanded, setExpanded] = useState(true);

  // Collapse automatically once the turn finishes; the user can reopen it.
  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);

  const topLevel = activities.filter((a) => !a.agent);
  const running =
    active &&
    (activities.some((a) => a.status === "running") || agents.some((a) => a.status === "running"));

  const unitCount = agents.length > 0 ? agents.length : activities.length;
  const noun = agents.length > 0 ? "agent" : "tool";
  const summary = running
    ? `Working (${unitCount} ${noun}${unitCount === 1 ? "" : "s"})`
    : `Used ${unitCount} ${noun}${unitCount === 1 ? "" : "s"}`;

  // A turn stopped mid-run leaves items "running"; show them done once inactive
  // so nothing spins forever.
  const settle = (status: ActivityStatus): ActivityStatus =>
    !active && status === "running" ? "done" : status;

  return (
    <div className="activity">
      <button className="activity-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`activity-chevron ${expanded ? "activity-chevron-open" : ""}`}>
          <ChevronIcon />
        </span>
        <span>{summary}</span>
      </button>
      {expanded && (
        <div className="activity-body">
          {topLevel.length > 0 && (
            <ul className="activity-list">
              {topLevel.map((activity) => (
                <ActivityRow
                  key={activity.id}
                  label={toolLabel(activity.name)}
                  title={activity.name}
                  status={settle(activity.status)}
                />
              ))}
            </ul>
          )}
          {agents.map((agent) => {
            const agentTools = activities.filter((a) => a.agent === agent.name);
            return (
              <div key={agent.name} className="activity-lane">
                <ActivityRow label={agentLabel(agent.name)} status={settle(agent.status)} lane />
                {agentTools.length > 0 && (
                  <ul className="activity-list activity-sublist">
                    {agentTools.map((activity) => (
                      <ActivityRow
                        key={activity.id}
                        label={toolLabel(activity.name)}
                        title={activity.name}
                        status={settle(activity.status)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  label,
  title,
  status,
  lane,
}: {
  label: string;
  title?: string;
  status: ActivityStatus;
  lane?: boolean;
}) {
  return (
    <div className={`activity-item activity-${status} ${lane ? "activity-lane-head" : ""}`}>
      <StatusIcon status={status} />
      <span className="activity-name" title={title}>
        {label}
      </span>
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

function StatusIcon({ status }: { status: ActivityStatus }) {
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
