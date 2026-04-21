import { useEffect, useState } from "react";
import { api } from "../api";
import type { Channel, ChannelRunLink, RunIndexEntry, Spawn } from "../types";
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
        {channel.repoAssignments.map((r) => {
          const isPrimary =
            channel.primaryWorkspaceId &&
            r.workspaceId === channel.primaryWorkspaceId;
          return (
            <div key={r.workspaceId} className="row">
              <span>
                @{r.alias}
                {isPrimary && <span className="primary-badge">PRIMARY</span>}
              </span>
              <span className="right" title={r.repoPath}>
                {basename(r.repoPath)}
              </span>
            </div>
          );
        })}
      </div>

      <SpawnedAgents channelId={channel.channelId} refreshTick={refreshTick} />

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

/**
 * Spawned agents panel — shows external Terminal-hosted agents launched
 * from this channel via the spawn flow. Empty state hides the whole
 * section (opt-in concept; not primary UI).
 *
 * We refetch on mount, on channelId change, and on every refreshTick so
 * the list stays roughly in sync with backend state even when other
 * surfaces trigger spawns. Kill is optimistic: we drop the row from
 * local state before the async call resolves, then rollback if it fails.
 */
function SpawnedAgents({
  channelId,
  refreshTick,
}: {
  channelId: string;
  refreshTick: number;
}) {
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const [killError, setKillError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listSpawns(channelId)
      .then((rows) => {
        if (!cancelled) setSpawns(rows);
      })
      .catch(() => {
        // Silently fall back to empty. listSpawns might fail if Task #24
        // hasn't registered its Tauri command yet; the section just
        // hides rather than showing a scary error.
        if (!cancelled) setSpawns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, refreshTick]);

  if (spawns.length === 0) return null;

  const kill = async (alias: string) => {
    setKillError(null);
    const before = spawns;
    // Optimistic remove.
    setSpawns((prev) => prev.filter((s) => s.alias !== alias));
    try {
      await api.killSpawnedAgent(channelId, alias);
    } catch (e) {
      setKillError(`Failed to kill @${alias}: ${e}`);
      setSpawns(before);
    }
  };

  return (
    <div className="section">
      <h4>Spawned agents ({spawns.length})</h4>
      <div className="spawn-list">
        {spawns.map((s) => (
          <div key={s.alias} className="spawn-row">
            <span className="spawn-alias">@{s.alias}</span>
            <span className="spawn-repo" title={s.repoPath}>
              {basename(s.repoPath)}
            </span>
            <button
              className="kill-button"
              onClick={() => kill(s.alias)}
              title="Kill this spawned agent"
            >
              Kill
            </button>
          </div>
        ))}
      </div>
      {killError && <div className="error">{killError}</div>}
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function stateClass(state: string): string {
  if (state === "DONE" || state === "COMPLETED") return "ok";
  if (state === "FAILED" || state === "ERROR") return "error";
  return "warn";
}
