import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { basename, deriveAlias } from "../lib/alias";
import type { Section, WorkspaceEntry } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (channelId: string) => void;
  /**
   * Section id to preselect on the first step. Usually the section the
   * user had visible in the sidebar when they clicked +; null = None /
   * Uncategorized.
   */
  defaultSectionId?: string | null;
};

type RepoRow = {
  workspace: WorkspaceEntry;
  selected: boolean;
  alias: string;
  spawn: boolean;
};

type Step = 1 | 2 | 3;

export function NewChannelModal({ open, onClose, onCreated, defaultSectionId }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [sectionId, setSectionId] = useState<string | null>(defaultSectionId ?? null);
  const [sections, setSections] = useState<Section[]>([]);
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
    setSectionId(defaultSectionId ?? null);
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
    api
      .listSections()
      .then(setSections)
      .catch(() => setSections([]));
  }, [open, defaultSectionId]);

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
      // address agree on the alias string. Dedupe any collisions by suffixing
      // `-2`, `-3` so two repos with the same basename (e.g. sibling branches
      // of the same project) still end up with unique aliases — otherwise the
      // Rust side's alias-uniqueness check rejects the whole create.
      const seen = new Map<string, number>();
      const sel = selectedRows.map((r) => {
        const base = (r.alias.trim() || defaultAlias(r.workspace.repoPath)).replace(
          /[^a-z0-9._-]/gi,
          ""
        );
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const alias = n === 0 ? base : `${base}-${n + 1}`;
        return {
          alias,
          workspaceId: r.workspace.workspaceId,
          repoPath: r.workspace.repoPath,
          spawn: r.spawn,
        };
      });
      const result = await api.createChannel(
        slug,
        topic.trim(),
        sel.map(({ alias, workspaceId, repoPath }) => ({ alias, workspaceId, repoPath })),
        primaryWorkspaceId ?? undefined
      );

      // Assign into a section after creation. `create_channel` shells
      // out to the CLI which doesn't understand sections, so the
      // assignment is a follow-up call — non-fatal: we warn but still
      // honor the channel create.
      if (sectionId) {
        try {
          await api.assignChannelSection(result.channelId, sectionId);
        } catch (err) {
          console.warn("[new-channel] section assign failed:", err);
        }
      }

      const warnings: string[] = [];
      if (result.droppedRepos && result.droppedRepos.length > 0) {
        warnings.push(
          `${result.droppedRepos.length} repo(s) skipped (unrepresentable): ${result.droppedRepos.join(", ")}`
        );
      }

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

  const primaryAlias =
    selectedRows.find((r) => r.workspace.workspaceId === primaryWorkspaceId)?.alias ?? "";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header modal-header-wizard">
          <span className="modal-hash" aria-hidden>
            #
          </span>
          <div className="modal-header-text">
            <div className="modal-title">New channel</div>
            <div className="modal-subtitle">
              Attach repos, set a primary, kick off with a first message.
            </div>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="wizard-stepper">
          {[
            { n: 1, label: "Basics" },
            { n: 2, label: "Repos" },
            { n: 3, label: "Kick off" },
          ].map((s, i, arr) => (
            <div key={s.n} className="wizard-stepper-row">
              <button
                type="button"
                className={`wizard-step-chip ${step === s.n ? "active" : ""} ${step > s.n ? "done" : ""}`}
                onClick={() => {
                  if (s.n < step || (s.n === 2 && canNextFromStep1) || s.n === step)
                    setStep(s.n as Step);
                }}
              >
                <span className="wizard-step-num">{step > s.n ? "✓" : s.n}</span>
                <span className="wizard-step-label">{s.label}</span>
              </button>
              {i < arr.length - 1 && (
                <div className={`wizard-step-connector ${step > s.n ? "done" : ""}`} />
              )}
            </div>
          ))}
        </div>
        <div className="modal-body">
          {step === 1 && (
            <div className="wizard-step">
              <label>
                Channel name
                <div className="wizard-name-field">
                  <span className="wizard-name-hash">#</span>
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="oauth-api-users"
                  />
                </div>
                <small style={{ color: "var(--color-text-dim)" }}>
                  Lowercase, dashes for spaces. Shown as <code>#{slug || "your-channel"}</code>.
                </small>
              </label>
              <label>
                Topic (optional)
                <input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="What is this channel for?"
                />
              </label>
              <label>
                Section
                <select
                  value={sectionId ?? ""}
                  onChange={(e) => setSectionId(e.target.value || null)}
                >
                  <option value="">None — Uncategorized</option>
                  {sections.map((s) => (
                    <option key={s.sectionId} value={s.sectionId}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <small style={{ color: "var(--color-text-dim)" }}>
                  {sections.length === 0
                    ? "Create a section from the sidebar to group channels."
                    : "Change any time from the sidebar kebab menu."}
                </small>
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step">
              <h3>Repos</h3>
              <p className="help">
                Attach workspaces to this channel. Each becomes a pingable <code>@alias</code>. One
                repo must be primary — its agent receives the kickoff message.
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
                            <label
                              className="repo-spawn-toggle"
                              title="Open an external Terminal agent"
                            >
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
              <p className="help">
                First message goes straight to the primary agent{" "}
                <strong
                  style={{ color: "var(--color-accent-coral)", fontFamily: "var(--font-mono)" }}
                >
                  @{primaryAlias}
                </strong>
                . Paste an issue URL, describe a feature, or ask a question — Relay classifies and
                either plans tickets or answers directly.
              </p>
              <label>
                First message
                <textarea
                  value={firstMessage}
                  onChange={(e) => setFirstMessage(e.target.value)}
                  placeholder={`e.g. "Add OAuth2 to /api/users — github and google to start." or paste an issue URL…`}
                  rows={6}
                />
              </label>
              <div className="wizard-summary">
                <div className="wizard-summary-title">Summary</div>
                <div className="wizard-summary-row">
                  Channel: <code>#{slug || "your-channel"}</code>
                </div>
                <div className="wizard-summary-row">
                  Repos:{" "}
                  {selectedRows.length === 0 ? (
                    <em>none</em>
                  ) : (
                    selectedRows.map((r, i) => {
                      const isPrimary = r.workspace.workspaceId === primaryWorkspaceId;
                      return (
                        <span key={r.workspace.workspaceId}>
                          {i > 0 && ", "}
                          <code
                            style={{
                              color: isPrimary
                                ? "var(--color-accent-coral)"
                                : "var(--color-text-primary)",
                            }}
                          >
                            @{r.alias}
                          </code>
                        </span>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}
          {spawnWarning && <div className="warning">{spawnWarning}</div>}
        </div>
        <div className="modal-footer">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {step > 1 && (
              <button onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
                ← Back
              </button>
            )}
          </div>
          <div className="wizard-footer-hint">
            Also:{" "}
            <code>
              /new #{slug || "name"} {selectedRows.map((r) => r.alias).join(",") || "repo1,repo2"}
            </code>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {step < 3 && (
              <button
                className="primary"
                onClick={() => setStep((s) => (s + 1) as Step)}
                disabled={(step === 1 && !canNextFromStep1) || (step === 2 && !canNextFromStep2)}
              >
                Next →
              </button>
            )}
            {step === 3 && (
              <button className="primary" onClick={submit} disabled={busy}>
                {busy ? "Creating…" : "Create & post"}
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

// Kept as a thin indirection so the rest of this file reads uniformly; the
// actual derivation lives in `lib/alias.ts` and is shared across every
// attach-repo surface.
function defaultAlias(repoPath: string): string {
  return deriveAlias(repoPath);
}
