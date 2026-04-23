import { useEffect, useState } from "react";
import { api } from "../api";
import { confirmAction, notifyError } from "../lib/dialogs";
import type { Channel, ProviderProfile, Spawn } from "../types";

type Tab = "repos" | "members" | "about";

type Props = {
  channel: Channel;
  onClose: () => void;
  onRefresh: () => void;
  onArchived: () => void;
};

export function ChannelSettingsDrawer({ channel, onClose, onRefresh, onArchived }: Props) {
  const [tab, setTab] = useState<Tab>("repos");

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label="Channel settings">
        <div className="drawer-header">
          <h3># {channel.name}</h3>
          <button className="rail-toggle" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="drawer-tabs">
          {(["repos", "members", "about"] as Tab[]).map((t) => (
            <div
              key={t}
              className={`drawer-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </div>
          ))}
        </div>
        <div className="drawer-body">
          {tab === "repos" && <ReposTab channel={channel} onRefresh={onRefresh} />}
          {tab === "members" && <MembersTab channel={channel} />}
          {tab === "about" && (
            <AboutTab channel={channel} onArchived={onArchived} onRefresh={onRefresh} />
          )}
        </div>
      </div>
    </>
  );
}

function ReposTab({ channel, onRefresh }: { channel: Channel; onRefresh: () => void }) {
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const primaryId = channel.primaryWorkspaceId ?? channel.repoAssignments[0]?.workspaceId;

  useEffect(() => {
    api
      .listSpawns(channel.channelId)
      .then(setSpawns)
      .catch(() => setSpawns([]));
  }, [channel.channelId]);

  const setPrimary = async (workspaceId: string) => {
    try {
      await api.setPrimaryRepo(channel.channelId, workspaceId);
      onRefresh();
    } catch (err) {
      await notifyError(`Promote failed: ${err}`);
    }
  };

  const detach = async (workspaceId: string) => {
    if (!(await confirmAction("Detach this repo from the channel?"))) return;
    const remaining = channel.repoAssignments
      .filter((r) => r.workspaceId !== workspaceId)
      .map((r) => ({ alias: r.alias, workspaceId: r.workspaceId, repoPath: r.repoPath }));
    try {
      await api.updateChannelRepos(channel.channelId, remaining);
      onRefresh();
    } catch (err) {
      await notifyError(`Detach failed: ${err}`);
    }
  };

  const spawn = async (alias: string, repoPath: string) => {
    try {
      const s = await api.spawnAgent(channel.channelId, alias, repoPath);
      setSpawns((prev) => [...prev, s]);
    } catch (err) {
      await notifyError(`Spawn failed: ${err}`);
    }
  };

  const killSpawn = async (alias: string) => {
    setSpawns((prev) => prev.filter((s) => s.alias !== alias));
    try {
      await api.killSpawnedAgent(channel.channelId, alias);
    } catch (err) {
      await notifyError(`Kill failed: ${err}`);
    }
  };

  return (
    <div className="drawer-repos">
      <div className="drawer-section">
        <h4>Attached repos · {channel.repoAssignments.length}</h4>
        <p className="drawer-section-hint">
          Each attached repo becomes a pingable <code>@alias</code>. The primary repo hosts the main
          channel agent.
        </p>
        <div className="drawer-repo-list">
          {channel.repoAssignments.map((r) => {
            const isPrimary = r.workspaceId === primaryId;
            const spawnRow = spawns.find((s) => s.alias === r.alias);
            return (
              <div key={r.workspaceId} className={`drawer-repo-row ${isPrimary ? "primary" : ""}`}>
                <span className={`drawer-repo-tile ${isPrimary ? "primary" : ""}`} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect
                      x="2"
                      y="2.5"
                      width="10"
                      height="9"
                      rx="1"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                    <path d="M4.5 5.5h5M4.5 8h3" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </span>
                <div className="drawer-repo-body">
                  <div className="drawer-repo-alias">
                    @{r.alias}
                    {isPrimary && <span className="drawer-repo-primary-badge">PRIMARY</span>}
                  </div>
                  <div className="drawer-repo-path">{r.repoPath}</div>
                </div>
                <div className="drawer-repo-actions">
                  {!isPrimary && (
                    <button onClick={() => setPrimary(r.workspaceId)}>Make primary</button>
                  )}
                  {spawnRow ? (
                    <button onClick={() => killSpawn(r.alias)}>Kill</button>
                  ) : (
                    <button onClick={() => spawn(r.alias, r.repoPath)}>Spawn</button>
                  )}
                  {!isPrimary && (
                    <button className="danger" onClick={() => detach(r.workspaceId)}>
                      Detach
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MembersTab({ channel }: { channel: Channel }) {
  return (
    <div className="drawer-section">
      <h4>Members ({channel.members.length})</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {channel.members.map((m) => (
          <div
            key={m.agentId}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 8,
              padding: 8,
              background: "var(--color-paper-alt)",
              borderRadius: 4,
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{m.displayName}</div>
              <div
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-dim)",
                }}
              >
                {m.provider} · {m.role}
              </div>
            </div>
            <span
              style={{
                fontSize: "var(--font-size-xs)",
                color:
                  m.status === "working" ? "var(--color-accent-amber)" : "var(--color-accent-mint)",
              }}
            >
              {m.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AboutTab({
  channel,
  onArchived,
  onRefresh,
}: {
  channel: Channel;
  onArchived: () => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<string>(channel.tier ?? "");
  const [fullAccess, setFullAccess] = useState<boolean>(channel.fullAccess === true);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [profileId, setProfileId] = useState<string>(channel.providerProfileId ?? "");

  useEffect(() => {
    let cancelled = false;
    api
      .listProviderProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        // PR 1 may not be merged yet — treat as "no profiles configured"
        // rather than popping an error dialog every time the drawer opens.
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveProfile = async (next: string) => {
    setProfileId(next);
    try {
      await api.setChannelProviderProfile(channel.channelId, next || null);
      onRefresh();
    } catch (err) {
      await notifyError(`Provider update failed: ${err}`);
    }
  };

  const toggleFullAccess = async () => {
    const next = !fullAccess;
    const prompt = next
      ? `Enable full access for #${channel.name}? All subprocesses spawned from this channel will run without permission prompts until this is turned off.`
      : `Disable full access for #${channel.name}? Permission prompts will return for new subprocesses.`;
    if (!(await confirmAction(prompt, { title: "Full access" }))) return;
    try {
      await api.setChannelFullAccess(channel.channelId, next);
      setFullAccess(next);
      onRefresh();
    } catch (err) {
      await notifyError(`Failed to toggle full access: ${err}`);
    }
  };

  const saveTier = async (next: string) => {
    setTier(next);
    try {
      await api.setChannelTier(channel.channelId, next || null);
      onRefresh();
    } catch (err) {
      await notifyError(`Tier update failed: ${err}`);
    }
  };

  const handleArchive = async () => {
    const archived = channel.status === "archived";
    const prompt = `${archived ? "Unarchive" : "Archive"} #${channel.name}?`;
    if (!(await confirmAction(prompt, { title: archived ? "Unarchive" : "Archive" }))) return;
    setBusy(true);
    try {
      if (archived) {
        await api.unarchiveChannel(channel.channelId);
      } else {
        await api.archiveChannel(channel.channelId);
        onArchived();
      }
      onRefresh();
    } catch (err) {
      await notifyError(`Failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="drawer-section">
        <h4>Topic</h4>
        <div>{channel.description || <em>No topic set</em>}</div>
      </div>
      <div className="drawer-section">
        <h4>Tier</h4>
        <select
          value={tier}
          onChange={(e) => saveTier(e.target.value)}
          style={{
            padding: "6px 10px",
            border: "1px solid var(--color-paper-line)",
            borderRadius: 4,
            background: "var(--color-paper-base)",
            fontFamily: "var(--font-ui)",
            fontSize: "var(--font-size-base)",
          }}
        >
          <option value="">(unset)</option>
          <option value="feature_large">Feature (large)</option>
          <option value="feature">Feature</option>
          <option value="bugfix">Bugfix</option>
          <option value="chore">Chore</option>
          <option value="question">Question</option>
        </select>
      </div>
      <div className="drawer-section">
        <h4>Provider</h4>
        <p
          style={{
            margin: "0 0 8px",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-muted)",
          }}
        >
          Profile chosen here wins at dispatch. "Inherit default" falls back to the global default
          profile, or <code>HARNESS_PROVIDER</code> if none is set.
        </p>
        <select
          value={profileId}
          onChange={(e) => saveProfile(e.target.value)}
          style={{
            padding: "6px 10px",
            border: "1px solid var(--color-paper-line)",
            borderRadius: 4,
            background: "var(--color-paper-base)",
            fontFamily: "var(--font-ui)",
            fontSize: "var(--font-size-base)",
          }}
        >
          <option value="">Inherit default</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName} ({p.adapter})
            </option>
          ))}
        </select>
      </div>
      <div className="drawer-section">
        <h4>Full access</h4>
        <p
          style={{
            margin: "0 0 8px",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-muted)",
          }}
        >
          Runs dispatched agents with workspace-write sandbox and no approval prompts. Scoped
          per-channel — other channels stay prompted.
        </p>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={fullAccess} onChange={toggleFullAccess} />
          {fullAccess ? "On" : "Off"}
        </label>
      </div>
      <div className="drawer-section">
        <h4>Status</h4>
        <div>{channel.status}</div>
        <button style={{ marginTop: 8 }} disabled={busy} onClick={handleArchive}>
          {channel.status === "archived" ? "Unarchive" : "Archive"}
        </button>
      </div>
      <div className="drawer-section">
        <h4>Created</h4>
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-dim)" }}>
          {channel.createdAt ?? "—"}
        </div>
      </div>
    </>
  );
}
