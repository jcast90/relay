import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  ApprovalQueueRecord,
  Channel,
  ChannelRunLink,
  Decision,
  PendingPlan,
  RunIndexEntry,
  TrackedPrRow,
} from "../types";
import { SessionList } from "./SessionList";

type Tab = "threads" | "decisions" | "prs";

type Props = {
  channel: Channel;
  sessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  refreshTick: number;
  onRefresh: () => void;
};

/**
 * AL-8 approvals section, rendered collapsibly above the regular tab
 * content when the queue has pending records for the selected session (or
 * any session when none is selected). Lists every pending record with
 * Approve / Reject buttons; both dispatch through `api.approveQueueEntry`
 * / `api.rejectQueueEntry` (→ `rly approve <id>` / `rly reject <id>`) so
 * the queue file mutation lives in one place regardless of which surface
 * drove the decision.
 *
 * Refresh cadence: we re-fetch on every parent `refreshTick` (5s in App)
 * so CLI/TUI-driven decisions show up without a manual reload.
 */
function ApprovalsSection({
  sessionId,
  refreshTick,
  onChanged,
}: {
  sessionId: string | null;
  refreshTick: number;
  onChanged: () => void;
}) {
  const [records, setRecords] = useState<ApprovalQueueRecord[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPendingApprovals(sessionId ?? undefined)
      .then((r) => {
        if (!cancelled) setRecords(r);
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  if (records.length === 0) return null;

  const act = async (record: ApprovalQueueRecord, decision: "approve" | "reject") => {
    setBusyId(record.id);
    setError(null);
    try {
      if (decision === "approve") await api.approveQueueEntry(record.id);
      else await api.rejectQueueEntry(record.id);
      setRecords((prev) => prev.filter((r) => r.id !== record.id));
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const approveAll = async () => {
    setBusyId("__all__");
    setError(null);
    try {
      await api.approveQueueAll(sessionId ?? undefined);
      setRecords([]);
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          marginBottom: 8,
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <h4
          style={{
            fontSize: "var(--font-size-xs)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--color-text-dim)",
            margin: 0,
          }}
        >
          Pending approvals ({records.length})
        </h4>
        <span style={{ color: "var(--color-text-dim)", fontSize: "var(--font-size-xs)" }}>
          {collapsed ? "▸" : "▾"}
        </span>
      </div>
      {!collapsed && (
        <>
          {records.length > 1 && (
            <button
              className="primary"
              disabled={busyId !== null}
              onClick={approveAll}
              style={{ marginBottom: 8, width: "100%" }}
            >
              {busyId === "__all__" ? "…" : `Approve all (${records.length})`}
            </button>
          )}
          {records.map((r) => (
            <div
              key={r.id}
              style={{
                padding: 10,
                background: "rgba(77, 152, 255, 0.10)",
                borderRadius: 6,
                marginBottom: 6,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{r.kind}</div>
              <div
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-muted)",
                  marginBottom: 6,
                  fontFamily: "var(--font-family-mono, monospace)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.id}
              >
                {r.id} · session {r.sessionId.slice(0, 8)}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="primary"
                  disabled={busyId === r.id}
                  onClick={() => act(r, "approve")}
                >
                  {busyId === r.id ? "…" : "Approve"}
                </button>
                <button disabled={busyId === r.id} onClick={() => act(r, "reject")}>
                  Reject
                </button>
              </div>
            </div>
          ))}
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}

export function RightPane({ channel, sessionId, onSelectSession, refreshTick, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>("threads");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [prs, setPrs] = useState<TrackedPrRow[]>([]);
  const [runs, setRuns] = useState<Array<{ run: RunIndexEntry; workspaceId: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listChannelDecisions(channel.channelId),
      api.listTrackedPrs(channel.channelId),
      api.listChannelRuns(channel.channelId),
    ])
      .then(async ([d, p, links]) => {
        if (cancelled) return;
        setDecisions(d);
        setPrs(p);
        const all = await Promise.all(
          links.map(async (link: ChannelRunLink) => {
            const ws = await api.listRuns(link.workspaceId);
            const match = ws.find((r) => r.runId === link.runId);
            return match ? { run: match, workspaceId: link.workspaceId } : null;
          })
        );
        if (!cancelled) {
          setRuns(all.filter((x): x is { run: RunIndexEntry; workspaceId: string } => x !== null));
        }
      })
      .catch(() => {
        /* surfaces don't need to be perfectly in sync; next refreshTick retries */
      });
    return () => {
      cancelled = true;
    };
  }, [channel.channelId, refreshTick]);

  useEffect(() => {
    if (prs.some((r) => r.ci === "failing")) setTab("prs");
  }, [prs]);

  return (
    <div className="right-rail">
      <div className="rail-tabs">
        {(["threads", "decisions", "prs"] as Tab[]).map((t) => (
          <div
            key={t}
            className={`rail-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "threads" ? "Threads" : t === "decisions" ? "Decisions" : "PRs"}
          </div>
        ))}
      </div>
      <div className="rail-scroll">
        <ApprovalsSection sessionId={sessionId} refreshTick={refreshTick} onChanged={onRefresh} />
        {tab === "threads" && (
          <SessionList
            channelId={channel.channelId}
            selectedSessionId={sessionId}
            onSelect={onSelectSession}
            refreshTick={refreshTick}
          />
        )}
        {tab === "decisions" && <DecisionsTab decisions={decisions} />}
        {tab === "prs" && (
          <PrsTab
            channel={channel}
            prs={prs}
            runs={runs}
            refreshTick={refreshTick}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </div>
  );
}

function DecisionsTab({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0) return <div className="rail-empty">No decisions</div>;
  return (
    <>
      {decisions.map((d) => (
        <div key={d.decisionId} className="rail-list-item">
          <div className="title">{d.title}</div>
          <div className="meta">
            {d.decidedByName} · {new Date(d.createdAt).toLocaleDateString()}
          </div>
        </div>
      ))}
    </>
  );
}

function PrsTab({
  channel,
  prs,
  runs,
  refreshTick,
  onRefresh,
}: {
  channel: Channel;
  prs: TrackedPrRow[];
  runs: Array<{ run: RunIndexEntry; workspaceId: string }>;
  refreshTick: number;
  onRefresh: () => void;
}) {
  return (
    <>
      <PendingPlanCta channel={channel} refreshTick={refreshTick} onChanged={onRefresh} />
      {prs.length === 0 && runs.length === 0 && <div className="rail-empty">No PRs tracked</div>}
      {prs.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h4
            style={{
              fontSize: "var(--font-size-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--color-text-dim)",
              margin: "0 0 8px",
            }}
          >
            Tracked PRs ({prs.length})
          </h4>
          {prs.map((r) => (
            <div key={`${r.ticketId}-${r.number}`} className="tracked-pr-row">
              <span className="tracked-pr-ticket" title={r.ticketId}>
                {r.ticketId.slice(0, 10)}
              </span>
              <a
                href={r.url}
                className="tracked-pr-link"
                target="_blank"
                rel="noreferrer noopener"
                title={r.branch}
              >
                #{r.number}
              </a>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-muted)",
                }}
              >
                {r.branch}
              </span>
              <span className="tracked-pr-badges">
                <span
                  className={`pr-dot pr-state-${r.prState ?? "unknown"}`}
                  title={`state: ${r.prState ?? "-"}`}
                />
                <span
                  className={`pr-dot pr-ci-${r.ci ?? "unknown"}`}
                  title={`ci: ${r.ci ?? "-"}`}
                />
                <span
                  className={`pr-dot pr-review-${r.review ?? "unknown"}`}
                  title={`review: ${r.review ?? "-"}`}
                />
              </span>
            </div>
          ))}
        </div>
      )}
      {runs.length > 0 && (
        <div>
          <h4
            style={{
              fontSize: "var(--font-size-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--color-text-dim)",
              margin: "0 0 8px",
            }}
          >
            Runs ({runs.length})
          </h4>
          {runs.map(({ run }) => (
            <div key={run.runId} className="rail-list-item">
              <div className="title">{run.featureRequest.slice(0, 48)}</div>
              <div className="meta">{run.state}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PendingPlanCta({
  channel,
  refreshTick,
  onChanged,
}: {
  channel: Channel;
  refreshTick: number;
  onChanged: () => void;
}) {
  const [plans, setPlans] = useState<PendingPlan[]>([]);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPendingPlans()
      .then((p) => {
        if (!cancelled) setPlans(p);
      })
      .catch(() => {
        if (!cancelled) setPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const relevant = plans.filter((p) => !p.channelId || p.channelId === channel.channelId);
  if (relevant.length === 0) return null;

  const act = async (plan: PendingPlan, decision: "approve" | "reject") => {
    setBusyRunId(plan.runId);
    setError(null);
    try {
      if (decision === "approve") await api.approvePlan(plan.runId);
      else await api.rejectPlan(plan.runId);
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyRunId(null);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {relevant.map((p) => (
        <div
          key={p.runId}
          style={{
            padding: 12,
            background: "rgba(232, 154, 43, 0.12)",
            borderRadius: 6,
            marginBottom: 8,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Plan awaiting approval</div>
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-muted)",
              marginBottom: 8,
            }}
          >
            {p.featureRequest.slice(0, 80)}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="primary"
              disabled={busyRunId === p.runId}
              onClick={() => act(p, "approve")}
            >
              {busyRunId === p.runId ? "…" : "Approve"}
            </button>
            <button disabled={busyRunId === p.runId} onClick={() => act(p, "reject")}>
              Reject
            </button>
          </div>
        </div>
      ))}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
