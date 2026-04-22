import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { WorkspaceEntry } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
};

type RepoRow = {
  workspace: WorkspaceEntry;
  selected: boolean;
  alias: string;
  spawn: boolean;
};

type Step = 1 | 2 | 3;

export function NewChannelModal({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [primaryWorkspaceId, setPrimaryWorkspaceId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spawnWarning, setSpawnWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setName("");
    setTopic("");
    setFilter("");
    setFirstMessage("");
    setError(null);
    setSpawnWarning(null);
    setPrimaryWorkspaceId(null);
    api.listWorkspaces().then((ws) => {
      setRepos(
        ws.map((w) => ({
          workspace: w,
          selected: false,
          alias: defaultAlias(w.repoPath),
          spawn: false,
        }))
      );
    });
  }, [open]);

  const visible = useMemo(() => {
    const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return repos
      .map((r, origIndex) => ({ row: r, origIndex }))
      .filter(({ row }) => {
        if (tokens.length === 0) return true;
        const haystack = [row.workspace.repoPath, row.workspace.workspaceId, row.alias]
          .join(" ")
          .toLowerCase();
        return tokens.every((tok) => haystack.includes(tok));
      });
  }, [repos, filter]);

  if (!open) return null;

  const selectedRows = repos.filter((r) => r.selected);
  const slug = slugify(name);
  const canNextFromStep1 = slug.length > 0;
  const canNextFromStep2 = selectedRows.length > 0 && !!primaryWorkspaceId;

  const toggleSelected = (origIndex: number) => {
    setRepos((prev) => {
      const next = prev.map((row, j) =>
        j === origIndex
          ? {
              ...row,
              selected: !row.selected,
              spawn: !row.selected ? row.spawn : false,
            }
          : row
      );
      setPrimaryWorkspaceId((currentPrimary) => {
        const sel = next.filter((r) => r.selected);
        if (sel.length === 0) return null;
        if (currentPrimary && sel.some((r) => r.workspace.workspaceId === currentPrimary)) {
          return currentPrimary;
        }
        return sel[0].workspace.workspaceId;
      });
      return next;
    });
  };

  const setPrimary = (workspaceId: string) => {
    if (!repos.find((r) => r.workspace.workspaceId === workspaceId && r.selected)) return;
    setPrimaryWorkspaceId(workspaceId);
  };
  const toggleSpawn = (origIndex: number) => {
    setRepos((prev) => prev.map((r, j) => (j === origIndex ? { ...r, spawn: !r.spawn } : r)));
  };
  const updateAlias = (origIndex: number, alias: string) => {
    setRepos((prev) => prev.map((r, j) => (j === origIndex ? { ...r, alias } : r)));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSpawnWarning(null);
    try {
      // Normalize aliases once; everything downstream (create, spawn, kickoff
      // routing) reads from `sel` so the persisted channel and the kickoff
      // address agree on the alias string.
      const sel = selectedRows.map((r) => ({
        alias: r.alias.trim() || defaultAlias(r.workspace.repoPath),
        workspaceId: r.workspace.workspaceId,
        repoPath: r.workspace.repoPath,
        spawn: r.spawn,
      }));
      const result = await api.createChannel(
        slug,
        topic.trim(),
        sel.map(({ alias, workspaceId, repoPath }) => ({ alias, workspaceId, repoPath })),
        primaryWorkspaceId ?? undefined
      );

      const warnings: string[] = [];

      const toSpawn = sel.filter((r) => r.spawn && r.workspaceId !== primaryWorkspaceId);
      if (toSpawn.length > 0) {
        const results = await Promise.all(
          toSpawn.map(async (r) => {
            try {
              await api.spawnAgent(result.channelId, r.alias, r.repoPath);
              return { ok: true as const };
            } catch {
              return { ok: false as const, alias: r.alias };
            }
          })
        );
        const failed = results.filter((x) => !x.ok);
        if (failed.length > 0) {
          warnings.push(`${failed.length}/${results.length} spawn(s) failed`);
        }
      }

      const kickoff = firstMessage.trim();
      if (kickoff) {
        const primary = sel.find((r) => r.workspaceId === primaryWorkspaceId);
        try {
          const session = await api.createSession(result.channelId, kickoff.slice(0, 60));
          await api.startChat({
            channelId: result.channelId,
            sessionId: session.sessionId,
            message: kickoff,
            alias: primary?.alias,
            cwd: primary?.repoPath,
            autoApprove: true,
          });
        } catch (err) {
          warnings.push(`Channel created but kickoff failed: ${err}. Send your message manually.`);
        }
      }

      if (warnings.length > 0) {
        setSpawnWarning(warnings.join(" · "));
        // Keep the modal open so the user can see the warning; they can close
        // manually via the × after reading it.
        onCreated(result.channelId);
        return;
      }

      onCreated(result.channelId);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          New channel
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {step === 1 && (
            <div className="wizard-step">
              <h3>Basics</h3>
              <p className="help">Give this channel a short name. Topic is optional.</p>
              <label>
                Channel name
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="oauth-api-users"
                />
                {name && slug !== name && (
                  <small style={{ color: "var(--color-text-dim)" }}>
                    will be #{slug}
                  </small>
                )}
              </label>
              <label>
                Topic
                <input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="What is this channel for?"
                />
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step">
              <h3>Repos</h3>
              <p className="help">
                Attach workspaces to this channel. Each becomes a pingable <code>@alias</code>.
                One repo must be primary — its agent receives the kickoff message.
              </p>
              <div className="repo-list-step">
                <input
                  className="repo-filter"
                  placeholder="Filter workspaces…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="repo-rows">
                  {visible.length === 0 ? (
                    <div className="rail-empty">
                      {repos.length === 0
                        ? "No registered workspaces. Run `rly up` in a repo first."
                        : "No match"}
                    </div>
                  ) : (
                    visible.map(({ row, origIndex }) => {
                      const isPrimary =
                        row.selected && primaryWorkspaceId === row.workspace.workspaceId;
                      return (
                        <div key={row.workspace.workspaceId} className="repo-row">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={() => toggleSelected(origIndex)}
                          />
                          <span className="repo-path" title={row.workspace.repoPath}>
                            {basename(row.workspace.repoPath)}
                            {isPrimary && <span className="primary-badge">primary</span>}
                          </span>
                          <input
                            className="alias-input"
                            value={row.alias}
                            onChange={(e) => updateAlias(origIndex, e.target.value)}
                            placeholder="alias"
                            disabled={!row.selected}
                          />
                          {row.selected ? (
                            <label className="repo-primary-radio">
                              <input
                                type="radio"
                                name="primary-workspace"
                                checked={isPrimary}
                                onChange={() => setPrimary(row.workspace.workspaceId)}
                              />
                              primary
                            </label>
                          ) : (
                            <span className="repo-primary-radio placeholder" />
                          )}
                          {row.selected && !isPrimary ? (
                            <label className="repo-spawn-toggle" title="Open an external Terminal agent">
                              <input
                                type="checkbox"
                                checked={row.spawn}
                                onChange={() => toggleSpawn(origIndex)}
                              />
                              spawn
                            </label>
                          ) : (
                            <span className="repo-spawn-toggle placeholder" />
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="wizard-step">
              <h3>Kick-off</h3>
              <p className="help">
                This first message goes straight to the primary agent (@{
                  selectedRows.find((r) => r.workspace.workspaceId === primaryWorkspaceId)?.alias
                }). The classifier assigns a tier and plans tickets.
              </p>
              <label>
                First message (optional)
                <textarea
                  value={firstMessage}
                  onChange={(e) => setFirstMessage(e.target.value)}
                  placeholder="Describe the work you want to kick off…"
                  rows={6}
                />
              </label>
            </div>
          )}

          {error && <div className="error">{error}</div>}
          {spawnWarning && <div className="warning">{spawnWarning}</div>}
        </div>
        <div className="modal-footer">
          <div className="steps">
            <span className={`step-dot ${step >= 1 ? "active" : ""}`} />
            <span className={`step-dot ${step >= 2 ? "active" : ""}`} />
            <span className={`step-dot ${step >= 3 ? "active" : ""}`} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 1 && (
              <button onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
                Back
              </button>
            )}
            {step < 3 && (
              <button
                className="primary"
                onClick={() => setStep((s) => (s + 1) as Step)}
                disabled={(step === 1 && !canNextFromStep1) || (step === 2 && !canNextFromStep2)}
              >
                Next
              </button>
            )}
            {step === 3 && (
              <button className="primary" onClick={submit} disabled={busy}>
                {busy ? "Creating…" : "Create channel"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function defaultAlias(repoPath: string): string {
  return basename(repoPath).replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 12);
}
