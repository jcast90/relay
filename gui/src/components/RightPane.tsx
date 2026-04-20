import { useEffect, useState } from "react";
import { api } from "../api";
import type { Channel, ChannelRunLink, RunIndexEntry } from "../types";
import { SessionList } from "./SessionList";

type Props = {
  channel: Channel | null;
  sessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  refreshTick: number;
};

export function RightPane({
  channel,
  sessionId,
  onSelectSession,
  refreshTick,
}: Props) {
  const [runs, setRuns] = useState<RunInfo[]>([]);

  useEffect(() => {
    if (!channel) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const links = await api.listChannelRuns(channel.channelId);
      const all = await Promise.all(
        links.map(async (link: ChannelRunLink) => {
          const ws = await api.listRuns(link.workspaceId);
          const match = ws.find((r) => r.runId === link.runId);
          return match ? { run: match, workspaceId: link.workspaceId } : null;
        }),
      );
      if (cancelled) return;
      setRuns(all.filter((x): x is RunInfo => x !== null));
    })();
    return () => {
      cancelled = true;
    };
  }, [channel?.channelId, refreshTick]);

  if (!channel) {
    return <div className="panel" />;
  }

  return (
    <div className="panel">
      <div className="panel-header">{channel.name}</div>

      <SessionList
        channelId={channel.channelId}
        selectedSessionId={sessionId}
        onSelect={onSelectSession}
        refreshTick={refreshTick}
      />

      <div className="section">
        <h4>Members ({channel.members.length})</h4>
        {channel.members.map((m) => (
          <div key={m.agentId} className="row">
            <span>{m.displayName}</span>
            <span className="right">{m.role}</span>
          </div>
        ))}
      </div>

      <div className="section">
        <h4>Repos ({channel.repoAssignments.length})</h4>
        {channel.repoAssignments.map((r) => (
          <div key={r.workspaceId} className="row">
            <span>@{r.alias}</span>
            <span className="right" title={r.repoPath}>
              {basename(r.repoPath)}
            </span>
          </div>
        ))}
      </div>

      <div className="section">
        <h4>Runs ({runs.length})</h4>
        {runs.length === 0 && <div className="row">No runs</div>}
        {runs.map(({ run }) => (
          <div key={run.runId} className="row">
            <span>{run.featureRequest.slice(0, 24)}</span>
            <span className={`badge ${stateClass(run.state)}`}>{run.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type RunInfo = { run: RunIndexEntry; workspaceId: string };

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function stateClass(state: string): string {
  if (state === "DONE" || state === "COMPLETED") return "ok";
  if (state === "FAILED" || state === "ERROR") return "error";
  return "warn";
}
