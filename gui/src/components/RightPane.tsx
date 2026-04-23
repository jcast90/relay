import { useEffect, useState } from "react";
import { api } from "../api";
import { openExternal } from "../lib/dialogs";
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
  onClose?: () => void;
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

export function RightPane({
  channel,
  sessionId,
  onSelectSession,
  refreshTick,
  onRefresh,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("threads");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [prs, setPrs] = useState<TrackedPrRow[]>([]);
  const [runs, setRuns] = useState<Array<{ run: RunIndexEntry; workspaceId: string }>>([]);
  // AL-10 previously resolved the active autonomous session here for its
  // ApprovalsPanel. Dropped — AL-8's `ApprovalsSection` below handles its
  // own session discovery against AL-7's queue. The CenterPane keeps its
  // own autonomous-session lookup for the header; the RightPane no longer
  // needs one.

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

  const [sessionCount, setSessionCount] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    api
      .listSessions(channel.channelId)
      .then((s) => {
        if (!cancelled) setSessionCount(s.length);
      })
      .catch(() => {
        if (!cancelled) setSessionCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [channel.channelId, refreshTick]);

  const counts: Record<Tab, number> = {
    threads: sessionCount,
    decisions: decisions.length,
    prs: prs.length,
  };

  return (
    <div className="right-rail">
      <div className="rail-tabs">
        {(["threads", "decisions", "prs"] as Tab[]).map((t) => (
          <button
            type="button"
            key={t}
            className={`rail-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            <span className="rail-tab-label">
              {t === "threads" ? "Threads" : t === "decisions" ? "Decisions" : "PRs"}
            </span>
            {counts[t] > 0 && <span className="tab-count">{counts[t]}</span>}
          </button>
        ))}
        {onClose && (
          <button
            type="button"
            className="rail-close"
            onClick={onClose}
            title="Close right rail"
            aria-label="Close right rail"
          >
            ×
          </button>
        )}
      </div>
      {/* AL-10 previously rendered its own ApprovalsPanel here. Dropped —
          AL-8's `ApprovalsSection` below owns the GUI approvals surface
          and reads AL-7's canonical queue. */}
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
  const [openId, setOpenId] = useState<string | null>(null);
  if (decisions.length === 0) return <div className="rail-empty">No decisions</div>;
  const open = openId ? decisions.find((d) => d.decisionId === openId) : null;
  if (open) {
    return (
      <div className="rail-detail">
        <button type="button" className="rail-back" onClick={() => setOpenId(null)}>
          ← Back
        </button>
        <div className="rail-detail-tag">
          <code>{open.decisionId.slice(0, 10)}</code>
          <span>
            by {open.decidedByName} · {formatDate(open.createdAt)}
          </span>
        </div>
        <h3 className="rail-detail-title">{open.title}</h3>
        <p className="rail-detail-body">{open.description}</p>
        {open.rationale && (
          <div className="rail-detail-rationale">
            <div className="rail-detail-rationale-tag">RATIONALE</div>
            <div>{open.rationale}</div>
          </div>
        )}
        {open.alternatives.length > 0 && (
          <div className="rail-detail-alts">
            <div className="rail-detail-rationale-tag">ALTERNATIVES</div>
            <ul>
              {open.alternatives.map((alt, i) => (
                <li key={i}>{alt}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="rail-decisions-list">
      {decisions.map((d) => (
        <button
          type="button"
          key={d.decisionId}
          className="rail-decision-card"
          onClick={() => setOpenId(d.decisionId)}
        >
          <div className="rail-decision-id">
            <code>{d.decisionId.slice(0, 10)}</code>
            <span>
              {d.decidedByName} · {formatDate(d.createdAt)}
            </span>
          </div>
          <div className="rail-decision-title">{d.title}</div>
          {d.description && <div className="rail-decision-preview">{d.description}</div>}
        </button>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
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
        <div className="rail-pr-list">
          <div className="rail-section-title" style={{ margin: "0 0 var(--space-4)" }}>
            Tracked PRs · {prs.length}
          </div>
          {prs.map((r) => {
            const ciLabel = r.ci ?? "pending";
            const reviewLabel = r.review ?? "pending";
            return (
              <button
                type="button"
                key={`${r.ticketId}-${r.number}`}
                className="rail-pr-card"
                onClick={() => openExternal(r.url)}
                title="Open in browser"
              >
                <div className="rail-pr-head">
                  <span className="rail-pr-num">#{r.number}</span>
                  <span className="rail-pr-branch">{r.branch}</span>
                  <span className="rail-pr-arrow">↗</span>
                </div>
                {r.ticketId && (
                  <div className="rail-pr-ticket">ticket {r.ticketId.slice(0, 10)}</div>
                )}
                <div className="rail-pr-footer">
                  <span className={`rail-pr-chip pr-ci-${r.ci ?? "unknown"}`}>
                    <span className="chip-dot" />CI {ciLabel}
                  </span>
                  <span className={`rail-pr-chip pr-review-${r.review ?? "unknown"}`}>
                    <span className="chip-dot" />review {reviewLabel}
                  </span>
                  {r.prState && (
                    <span className={`rail-pr-chip pr-state-${r.prState}`}>
                      <span className="chip-dot" />
                      {r.prState}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
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
