import { useEffect, useRef, useState } from "react";
import { api, type ChatEvent } from "../api";
import { notifyError } from "../lib/dialogs";
import type { Channel, ChatSession, WorkspaceEntry } from "../types";

type ActivityEntry = { text: string; ts: number };

export type ActiveStream = {
  streamId: number;
  alias: string | null;
  accum: string;
  activity: ActivityEntry[];
  expanded: boolean;
};

export type StreamDispatch = (s: ActiveStream | null) => void;

type Props = {
  channel: Channel;
  sessionId: string | null;
  activeSession: ChatSession | null;
  streaming: boolean;
  onStartStream: StreamDispatch;
  onSessionCreated: (sessionId: string) => void;
  // DM-only: invoked when the user types `/new` at the start of the
  // composer and hits Enter. If omitted, `/new` is sent as a normal message.
  onSlashNew?: () => void;
};

export function Composer({
  channel,
  sessionId,
  activeSession,
  streaming,
  onStartStream,
  onSessionCreated,
  onSlashNew,
}: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(
    null
  );
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [attaching, setAttaching] = useState<string | null>(null);

  // Load the global workspace pool once — used by the attach-on-command
  // row in the mention popover. Silently empty on failure; worst case we
  // just don't offer the "Attach @foo?" affordance.
  useEffect(() => {
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, []);

  const aliases = channel.repoAssignments.map((r) => r.alias);
  const primaryId = channel.primaryWorkspaceId ?? channel.repoAssignments[0]?.workspaceId;
  const primaryAlias =
    channel.repoAssignments.find((r) => r.workspaceId === primaryId)?.alias ?? "";

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = before.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    if (!match) return null;
    const start = caret - match[1].length - 1;
    return { start, query: match[1] };
  };
  const filteredAliases = mention
    ? aliases.filter((a) => a.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];

  // Attach-on-command: when the user types `@foo` and `foo` is a
  // registered workspace that's NOT currently attached to this channel,
  // surface an inline "Attach @foo" action so they don't have to open the
  // settings drawer. Empty query → no suggestion.
  const attachedWorkspaceIds = new Set(channel.repoAssignments.map((r) => r.workspaceId));
  const attachCandidate =
    mention && mention.query
      ? workspaces.find((w) => {
          if (attachedWorkspaceIds.has(w.workspaceId)) return false;
          const alias = basename(w.repoPath)
            .replace(/[^a-z0-9-]/gi, "")
            .toLowerCase()
            .slice(0, 12);
          return alias.startsWith(mention.query.toLowerCase());
        })
      : undefined;
  const attachAlias = attachCandidate
    ? basename(attachCandidate.repoPath)
        .replace(/[^a-z0-9-]/gi, "")
        .toLowerCase()
        .slice(0, 12)
    : "";

  const attachNow = async () => {
    if (!attachCandidate) return;
    setAttaching(attachCandidate.workspaceId);
    try {
      const next = [
        ...channel.repoAssignments.map((r) => ({
          alias: r.alias,
          workspaceId: r.workspaceId,
          repoPath: r.repoPath,
        })),
        {
          alias: attachAlias,
          workspaceId: attachCandidate.workspaceId,
          repoPath: attachCandidate.repoPath,
        },
      ];
      await api.updateChannelRepos(channel.channelId, next);
      applyMention(attachAlias);
    } catch (err) {
      await notifyError(`Attach failed: ${err}`);
    } finally {
      setAttaching(null);
    }
  };

  const applyMention = (alias: string) => {
    if (!mention) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const before = text.slice(0, mention.start);
    const after = text.slice(caret);
    const insertion = `@${alias} `;
    const next = before + insertion + after;
    setText(next);
    setMention(null);
    const nextCaret = before.length + insertion.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    const next = detectMention(value, e.target.selectionStart ?? value.length);
    setMention(next ? { ...next, index: 0 } : null);
  };

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const next = detectMention(el.value, el.selectionStart ?? el.value.length);
    setMention((prev) =>
      next ? { ...next, index: prev && prev.start === next.start ? prev.index : 0 } : null
    );
  };

  const send = async () => {
    const raw = text.trim();
    if (!raw) return;
    // `/new` at the start of a DM composer promotes the DM to a channel
    // instead of sending. Short-circuits before any backend call.
    if (onSlashNew && raw === "/new") {
      setText("");
      onSlashNew();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { alias, body } = parseAliasPrefix(raw, aliases);
      const target = alias ?? primaryAlias;
      const repo = target ? channel.repoAssignments.find((r) => r.alias === target) : null;
      const cwd = repo?.repoPath;
      const aliasKey = target || "general";
      const claudeSessionId = activeSession?.claudeSessionIds?.[aliasKey] ?? undefined;

      let activeId = sessionId;
      if (!activeId) {
        const session = await api.createSession(channel.channelId, raw.slice(0, 60));
        activeId = session.sessionId;
        onSessionCreated(activeId);
      }

      let rewindKey: string | undefined;
      if (channel.repoAssignments.length > 0) {
        try {
          const snap = await api.rewindSnapshot(channel.channelId, activeId);
          rewindKey = snap.key;
        } catch (err) {
          console.warn("[rewind] snapshot failed:", err);
        }
      }

      const streamId = await api.startChat({
        channelId: channel.channelId,
        sessionId: activeId,
        message: body,
        alias: target || undefined,
        cwd,
        claudeSessionId,
        autoApprove,
        rewindKey,
      });
      onStartStream({
        streamId,
        alias: target || null,
        accum: "",
        activity: [],
        expanded: false,
      });
      setText("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && filteredAliases.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention({ ...mention, index: (mention.index + 1) % filteredAliases.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention({
          ...mention,
          index: (mention.index - 1 + filteredAliases.length) % filteredAliases.length,
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(filteredAliases[mention.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const disabled = busy || streaming;
  const showMentions = !!mention && (filteredAliases.length > 0 || !!attachCandidate);

  // Scan the drafted text for @alias mentions of registered-but-unattached
  // workspaces. The user can still send — we just surface a heads-up that
  // those agents won't be routed to. One-click attach per offender.
  const unattachedMentions = computeUnattachedMentions(text, channel, workspaces);
  const attachFromWarning = async (ws: {
    workspaceId: string;
    repoPath: string;
    alias: string;
  }) => {
    setAttaching(ws.workspaceId);
    try {
      const next = [
        ...channel.repoAssignments.map((r) => ({
          alias: r.alias,
          workspaceId: r.workspaceId,
          repoPath: r.repoPath,
        })),
        { alias: ws.alias, workspaceId: ws.workspaceId, repoPath: ws.repoPath },
      ];
      await api.updateChannelRepos(channel.channelId, next);
    } catch (err) {
      await notifyError(`Attach failed: ${err}`);
    } finally {
      setAttaching(null);
    }
  };

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}
      {unattachedMentions.length > 0 && (
        <div className="composer-warn" role="status">
          <span>
            ⚠{" "}
            {unattachedMentions.map((m, i) => (
              <span key={m.workspaceId}>
                {i > 0 && ", "}
                <code className="mention mention-repo-attached">@{m.alias}</code>
              </span>
            ))}{" "}
            {unattachedMentions.length === 1 ? "is" : "are"} registered but not attached — won't be
            routed.
          </span>
          {unattachedMentions.map((m) => (
            <button
              key={m.workspaceId}
              type="button"
              disabled={attaching === m.workspaceId}
              onClick={() => attachFromWarning(m)}
              title={`Attach @${m.alias} (${m.repoPath}) to this channel`}
            >
              {attaching === m.workspaceId ? "…" : `Attach @${m.alias}`}
            </button>
          ))}
        </div>
      )}
      {primaryAlias && (
        <div className="composer-routing">
          <span>→</span>
          <span className="route-chip">@{primaryAlias}</span>
          <span>primary · override with @alias</span>
        </div>
      )}
      <div className="composer-body">
        {showMentions && (
          <MentionPopover
            channel={channel}
            aliases={filteredAliases}
            index={mention!.index}
            onPick={applyMention}
            attachCandidate={
              attachCandidate ? { alias: attachAlias, path: attachCandidate.repoPath } : undefined
            }
            attaching={attaching === attachCandidate?.workspaceId}
            onAttach={attachNow}
          />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={onKeyDown}
          onSelect={handleSelect}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          placeholder={`Message #${channel.name}…  Enter to send · Shift+Enter newline`}
          rows={2}
          disabled={disabled}
        />
      </div>
      <div className="composer-controls">
        <label className="auto-approve" title="Pass --dangerously-skip-permissions to claude">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
          />
          Auto-approve
        </label>
        <span className="composer-hint">⌘⏎ to send</span>
        <button className="primary" onClick={send} disabled={disabled || !text.trim()}>
          {streaming ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function MentionPopover({
  channel,
  aliases,
  index,
  onPick,
  attachCandidate,
  attaching,
  onAttach,
}: {
  channel: Channel;
  aliases: string[];
  index: number;
  onPick: (alias: string) => void;
  attachCandidate?: { alias: string; path: string };
  attaching: boolean;
  onAttach: () => void;
}) {
  return (
    <div className="mention-popover" role="listbox">
      {aliases.map((a, i) => {
        const repo = channel.repoAssignments.find((r) => r.alias === a);
        return (
          <button
            key={a}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`mention-option ${i === index ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(a);
            }}
          >
            <span className="mention-alias">@{a}</span>
            {repo?.repoPath && <span className="mention-path">{repo.repoPath}</span>}
          </button>
        );
      })}
      {attachCandidate && (
        <button
          type="button"
          className="mention-option"
          style={{
            borderTop: aliases.length > 0 ? "1px solid var(--color-paper-line)" : undefined,
            marginTop: aliases.length > 0 ? 4 : 0,
            paddingTop: aliases.length > 0 ? 8 : undefined,
          }}
          disabled={attaching}
          onMouseDown={(e) => {
            e.preventDefault();
            onAttach();
          }}
          title="Attach this workspace to the channel"
        >
          <span className="mention-alias">+ @{attachCandidate.alias}</span>
          <span className="mention-path">
            {attaching ? "attaching…" : `attach ${attachCandidate.path}`}
          </span>
        </button>
      )}
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/**
 * Scan `text` for `@alias` mentions where `alias` matches a registered
 * workspace that's NOT currently attached to the channel. Returns the
 * unique list so the composer can warn the user pre-send; the message is
 * still deliverable, the warning is advisory.
 */
function computeUnattachedMentions(
  text: string,
  channel: Channel,
  workspaces: WorkspaceEntry[]
): Array<{ workspaceId: string; repoPath: string; alias: string }> {
  if (!text.trim()) return [];
  const attachedAliases = new Set(channel.repoAssignments.map((r) => r.alias.toLowerCase()));
  const attachedWorkspaceIds = new Set(channel.repoAssignments.map((r) => r.workspaceId));
  const candidatesByAlias = new Map<
    string,
    { workspaceId: string; repoPath: string; alias: string }
  >();
  for (const w of workspaces) {
    if (attachedWorkspaceIds.has(w.workspaceId)) continue;
    const alias = basename(w.repoPath)
      .replace(/[^a-z0-9-]/gi, "")
      .toLowerCase()
      .slice(0, 12);
    if (!alias) continue;
    if (!candidatesByAlias.has(alias)) {
      candidatesByAlias.set(alias, { workspaceId: w.workspaceId, repoPath: w.repoPath, alias });
    }
  }
  const hits = new Map<string, { workspaceId: string; repoPath: string; alias: string }>();
  for (const match of text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)) {
    const alias = match[1].toLowerCase();
    if (attachedAliases.has(alias)) continue;
    const cand = candidatesByAlias.get(alias);
    if (cand) hits.set(cand.workspaceId, cand);
  }
  return Array.from(hits.values());
}

function parseAliasPrefix(
  message: string,
  aliases: string[]
): { alias: string | null; body: string } {
  const match = message.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]*)$/);
  if (!match) return { alias: null, body: message };
  const candidate = match[1];
  if (!aliases.includes(candidate)) return { alias: null, body: message };
  return { alias: candidate, body: match[2] };
}

export function reduceStream(current: ActiveStream, event: ChatEvent): ActiveStream {
  const ACTIVITY_STACK_MAX = 20;
  switch (event.kind) {
    case "chunk":
      return { ...current, accum: current.accum + event.text };
    case "activity": {
      const keep = current.activity.slice(-(ACTIVITY_STACK_MAX - 1));
      return {
        ...current,
        activity: [...keep, { text: event.text, ts: Date.now() }],
      };
    }
    default:
      return current;
  }
}
