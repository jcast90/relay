import { useEffect, useMemo, useRef, useState } from "react";
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
  // Only one row can be primary at a time. We track it at the workspace-id
  // level (see `primaryWorkspaceId` below) rather than on the row so the
  // invariant "at most one primary" is centrally enforced.
  spawn: boolean;
};

export function NewChannelModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [filter, setFilter] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-fatal warning shown after createChannel succeeds but one or more
  // spawnAgent calls failed. We still navigate to the channel regardless.
  const [spawnWarning, setSpawnWarning] = useState<string | null>(null);
  // Which workspace is flagged primary. Null until the user checks the
  // first row, at which point we auto-set to that row. If the current
  // primary is later unchecked, we reassign to the earliest still-
  // selected row (by master-array order, not visible order).
  const [primaryWorkspaceId, setPrimaryWorkspaceId] = useState<string | null>(
    null,
  );
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setFilter("");
    setHighlightIdx(0);
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
        })),
      );
    });
  }, [open]);

  // Visible rows after filter. `origIndex` keeps a pointer back to the master
  // `repos` array so toggles / alias edits never corrupt non-visible
  // selections when the filter changes.
  const visible = useMemo(() => {
    const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return repos
      .map((r, origIndex) => ({ row: r, origIndex }))
      .filter(({ row }) => {
        if (tokens.length === 0) return true;
        const haystack = [
          row.workspace.repoPath,
          row.workspace.workspaceId,
          row.alias,
        ]
          .join(" ")
          .toLowerCase();
        return tokens.every((tok) => haystack.includes(tok));
      });
  }, [repos, filter]);

  useEffect(() => {
    if (highlightIdx >= visible.length) {
      setHighlightIdx(Math.max(0, visible.length - 1));
    }
  }, [visible.length, highlightIdx]);

  if (!open) return null;

  const toggleSelected = (origIndex: number) => {
    // Compute next state based on current master array, then fold in the
    // primary-assignment rule in a single pass so we don't race with React
    // batching two setState calls.
    setRepos((prev) => {
      const next = prev.map((row, j) => {
        if (j !== origIndex) return row;
        const nowSelected = !row.selected;
        // Deselecting also clears spawn so we don't carry a stale opt-in
        // forward if the user re-selects later.
        return {
          ...row,
          selected: nowSelected,
          spawn: nowSelected ? row.spawn : false,
        };
      });
      // Auto-assign / reassign primary:
      //   - If nothing is currently primary and we just selected a row,
      //     that row becomes primary.
      //   - If the current primary just got unchecked, hand primary to the
      //     earliest still-selected row (master-array order).
      //   - If no selected rows remain, clear primary.
      setPrimaryWorkspaceId((currentPrimary) => {
        const selectedRows = next.filter((r) => r.selected);
        if (selectedRows.length === 0) return null;
        if (
          currentPrimary &&
          selectedRows.some((r) => r.workspace.workspaceId === currentPrimary)
        ) {
          return currentPrimary;
        }
        return selectedRows[0].workspace.workspaceId;
      });
      return next;
    });
  };

  const setPrimary = (workspaceId: string) => {
    // Radio-click: assumes the row is already selected (the radio is only
    // rendered on selected rows). Defensive: verify and no-op otherwise.
    setRepos((prev) => {
      const match = prev.find(
        (r) => r.workspace.workspaceId === workspaceId && r.selected,
      );
      if (!match) return prev;
      setPrimaryWorkspaceId(workspaceId);
      return prev;
    });
  };

  const toggleSpawn = (origIndex: number) => {
    setRepos((prev) =>
      prev.map((row, j) =>
        j === origIndex ? { ...row, spawn: !row.spawn } : row,
      ),
    );
  };

  const updateAlias = (origIndex: number, alias: string) => {
    setRepos((prev) =>
      prev.map((row, j) => (j === origIndex ? { ...row, alias } : row)),
    );
  };

  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(0, i - 1));
    } else if (e.key === " ") {
      // Space toggles the currently highlighted row when the filter field has
      // focus. Avoids the built-in "space in a text input" conflict by only
      // intercepting when there's a highlighted visible row.
      const target = visible[highlightIdx];
      if (target) {
        e.preventDefault();
        toggleSelected(target.origIndex);
      }
    } else if (e.key === "Escape") {
      if (filter.length > 0) {
        e.preventDefault();
        setFilter("");
      }
    }
  };

  const selectedCount = repos.filter((r) => r.selected).length;

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    setSpawnWarning(null);
    try {
      const selectedRows = repos.filter((r) => r.selected);
      const selected = selectedRows.map((r) => ({
        alias: r.alias.trim() || defaultAlias(r.workspace.repoPath),
        workspaceId: r.workspace.workspaceId,
        repoPath: r.workspace.repoPath,
      }));
      const effectivePrimary =
        primaryWorkspaceId ?? selectedRows[0]?.workspace.workspaceId ?? undefined;
      const result = await api.createChannel(
        name.trim(),
        description.trim(),
        selected,
        effectivePrimary,
      );

      // Spawn all non-primary rows that were opted-in. Run in parallel; a
      // spawn failure surfaces as a warning but doesn't block navigation —
      // the channel was created successfully, and the user can still
      // launch agents later from the right pane.
      const toSpawn = selectedRows.filter(
        (r) =>
          r.spawn &&
          r.workspace.workspaceId !== effectivePrimary,
      );
      if (toSpawn.length > 0) {
        const results = await Promise.all(
          toSpawn.map(async (r) => {
            const alias = r.alias.trim() || defaultAlias(r.workspace.repoPath);
            try {
              await api.spawnAgent(
                result.channelId,
                alias,
                r.workspace.repoPath,
              );
              return { alias, ok: true as const };
            } catch (e) {
              return { alias, ok: false as const, error: String(e) };
            }
          }),
        );
        const failures = results.filter((x) => !x.ok);
        if (failures.length > 0) {
          setSpawnWarning(
            `Channel created, but ${failures.length}/${results.length} spawn(s) failed: ` +
              failures.map((f) => `@${f.alias}`).join(", "),
          );
        }
      }

      onCreated(result.channelId);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New channel</div>
        <div className="modal-body">
          <label>
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. proposal-pilot"
            />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </label>
          <div className="repo-list">
            <div className="repo-list-head">
              <span className="modal-subhead">
                Repos ({visible.length}/{repos.length}
                {selectedCount > 0 ? ` · ${selectedCount} selected` : ""})
              </span>
            </div>
            {repos.length === 0 ? (
              <div className="empty">
                No registered workspaces. Run `rly up` in a repo first.
              </div>
            ) : (
              <>
                <input
                  ref={filterRef}
                  className="repo-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={onFilterKeyDown}
                  placeholder="filter by path, alias, or workspace id · ↑↓ navigate · Space toggle · Esc clear"
                />
                <div className="repo-rows">
                  {visible.length === 0 ? (
                    <div className="empty">No repos match “{filter}”.</div>
                  ) : (
                    visible.map(({ row, origIndex }, i) => {
                      const isPrimary =
                        row.selected &&
                        primaryWorkspaceId === row.workspace.workspaceId;
                      return (
                        <div
                          key={row.workspace.workspaceId}
                          className={`repo-row ${i === highlightIdx ? "highlighted" : ""}`}
                          onClick={() => setHighlightIdx(i)}
                        >
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={() => toggleSelected(origIndex)}
                            title="Include this repo in the channel"
                          />
                          <span
                            className="repo-path"
                            title={row.workspace.repoPath}
                          >
                            {basename(row.workspace.repoPath)}
                            {isPrimary && (
                              <span className="primary-badge">PRIMARY</span>
                            )}
                          </span>
                          <input
                            className="alias-input"
                            value={row.alias}
                            onChange={(e) => updateAlias(origIndex, e.target.value)}
                            placeholder="alias"
                            disabled={!row.selected}
                          />
                          {/* Primary radio: only rendered on selected rows.
                              The label is the clickable surface; clicking the
                              radio explicitly promotes this repo to primary. */}
                          {row.selected ? (
                            <label
                              className="repo-primary-radio"
                              title="Primary agent runs in the GUI main chat"
                            >
                              <input
                                type="radio"
                                name="primary-workspace"
                                checked={isPrimary}
                                onChange={() =>
                                  setPrimary(row.workspace.workspaceId)
                                }
                              />
                              primary
                            </label>
                          ) : (
                            <span className="repo-primary-radio placeholder" />
                          )}
                          {/* Spawn checkbox: opt-in, visible only for
                              non-primary selected rows. The primary agent
                              runs in the main chat, so "spawn" doesn't
                              apply to it. */}
                          {row.selected && !isPrimary ? (
                            <label
                              className="repo-spawn-toggle"
                              title="Launch an external Terminal agent for this repo on channel create"
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
              </>
            )}
          </div>
          {error && <div className="error">{error}</div>}
          {spawnWarning && <div className="warning">{spawnWarning}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function defaultAlias(repoPath: string): string {
  return basename(repoPath).replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 12);
}
