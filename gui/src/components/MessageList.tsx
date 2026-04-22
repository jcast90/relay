import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Channel, ChannelEntry, PersistedChatMessage } from "../types";
import { renderWithMentions } from "../lib/mentions";
import { toUiChannel } from "../lib/channel";
import type { ActiveStream } from "./Composer";

const ACTIVITY_TOP_N = 3;

type Props = {
  channel: Channel;
  sessionId: string | null;
  feed: ChannelEntry[];
  sessionMessages: PersistedChatMessage[];
  stream: ActiveStream | null;
  streamId: number | null;
  onToggleStreamExpanded: () => void;
  onRewound: () => void;
};

export function MessageList({
  channel,
  sessionId,
  feed,
  sessionMessages,
  stream,
  streamId,
  onToggleStreamExpanded,
  onRewound,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ui = toUiChannel(channel);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionMessages.length, feed.length, sessionId, stream?.accum.length]);

  return (
    <div className="chat-scroll" ref={scrollRef}>
      {sessionId ? (
        <SessionMessages
          channel={channel}
          sessionId={sessionId}
          messages={sessionMessages}
          streaming={!!stream}
          streamId={streamId}
          onRewound={onRewound}
        />
      ) : (
        <FeedView entries={feed} channel={ui} />
      )}
      {stream && (
        <StreamCard stream={stream} channel={ui} onToggleExpanded={onToggleStreamExpanded} />
      )}
    </div>
  );
}

function FeedView({
  entries,
  channel,
}: {
  entries: ChannelEntry[];
  channel: ReturnType<typeof toUiChannel>;
}) {
  if (entries.length === 0) return <div className="chat-empty">No activity yet</div>;
  return (
    <>
      {entries.map((e) => (
        <div key={e.entryId} className={`message role-${e.type}`}>
          <div className="msg-avatar">
            {(e.fromDisplayName ?? e.type).slice(0, 1).toUpperCase()}
          </div>
          <div>
            <div className="msg-head">
              <span className="msg-author">{e.fromDisplayName ?? e.type}</span>
              <span className="msg-time">{formatTime(e.createdAt)}</span>
            </div>
            <div className="msg-body">{renderWithMentions(e.content, channel)}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function SessionMessages({
  channel,
  sessionId,
  messages,
  streaming,
  streamId,
  onRewound,
}: {
  channel: Channel;
  sessionId: string;
  messages: PersistedChatMessage[];
  streaming: boolean;
  streamId: number | null;
  onRewound: () => void;
}) {
  const ui = toUiChannel(channel);
  const [rewindTarget, setRewindTarget] = useState<PersistedChatMessage | null>(null);

  if (messages.length === 0)
    return <div className="chat-empty">No messages in this session yet</div>;
  return (
    <>
      {messages.map((m, i) => {
        const rewindKey = m.metadata?.rewindKey;
        const canRewind = m.role === "user" && !!rewindKey && !streaming;
        return (
          <div key={i} className={`message role-${m.role}`}>
            <div className="msg-avatar">
              {m.agentAlias
                ? m.agentAlias.slice(0, 1).toUpperCase()
                : m.role.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="msg-head">
                <span className="msg-author">{m.agentAlias ? `@${m.agentAlias}` : m.role}</span>
                <span className="msg-time">{formatTime(m.timestamp)}</span>
                <span className="msg-actions">
                  {m.role === "user" && rewindKey && (
                    <button
                      className="msg-action-btn"
                      disabled={!canRewind}
                      title={
                        streaming
                          ? "Finish the current stream before rewinding"
                          : "Rewind repos + chat to this turn"
                      }
                      onClick={() => setRewindTarget(m)}
                    >
                      ⟲ Rewind
                    </button>
                  )}
                </span>
              </div>
              <div className="msg-body">{renderWithMentions(m.content, ui)}</div>
            </div>
          </div>
        );
      })}
      {rewindTarget && (
        <RewindConfirmModal
          channel={channel}
          sessionId={sessionId}
          target={rewindTarget}
          streamId={streamId}
          onClose={() => setRewindTarget(null)}
          onDone={() => {
            setRewindTarget(null);
            onRewound();
          }}
        />
      )}
    </>
  );
}

function RewindConfirmModal({
  channel,
  sessionId,
  target,
  streamId,
  onClose,
  onDone,
}: {
  channel: Channel;
  sessionId: string;
  target: PersistedChatMessage;
  streamId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rewindKey = target.metadata?.rewindKey;

  const apply = async () => {
    if (!rewindKey) {
      setError("Message has no rewindKey metadata — cannot rewind.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (streamId !== null) {
        try {
          await api.cancelChatStream(streamId);
        } catch (err) {
          console.warn("[rewind] cancelChatStream failed:", err);
        }
      }
      await api.rewindApply(channel.channelId, sessionId, rewindKey, target.timestamp);
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          Rewind to this turn?
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>
            Each repo in this channel will be reset to the commit captured before this message.
            Messages at or after this turn will be removed from the session.
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 10,
              background: "var(--color-paper-alt)",
              borderRadius: 4,
            }}
          >
            {channel.repoAssignments.map((r) => (
              <div
                key={r.alias}
                style={{ display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 12 }}
              >
                <code>@{r.alias}</code>
                <span style={{ color: "var(--color-text-dim)" }}>{r.repoPath}</span>
              </div>
            ))}
          </div>
          <div
            style={{
              color: "var(--color-accent-coral)",
              background: "var(--color-accent-coral-soft)",
              padding: 8,
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <strong>Warning:</strong> this runs <code>git reset --hard</code>. Uncommitted changes
            will be lost. Shell side effects are not undone.
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={apply} disabled={busy || !rewindKey}>
            {busy ? "Rewinding…" : "Rewind"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StreamCard({
  stream,
  channel,
  onToggleExpanded,
}: {
  stream: ActiveStream;
  channel: ReturnType<typeof toUiChannel>;
  onToggleExpanded: () => void;
}) {
  const total = stream.activity.length;
  const visibleCount = stream.expanded ? total : Math.min(ACTIVITY_TOP_N, total);
  const visible = total === 0 ? [] : stream.activity.slice(total - visibleCount);
  const hiddenCount = total - visibleCount;

  return (
    <div className="stream-card">
      <div className="stream-card-head">
        <span className="dot" />
        <span className="author">{stream.alias ? `@${stream.alias}` : "assistant"}</span>
        <span>
          {stream.accum ? "writing response" : "thinking"}
          {total > 0 ? ` · ${total} action${total === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className={`stream-activity ${stream.expanded ? "expanded" : ""}`}>
        {visible.map((entry, i) => {
          const isNewest = i === visible.length - 1;
          return (
            <div
              key={`${entry.ts}-${i}`}
              className={`stream-activity-line ${isNewest ? "newest" : ""}`}
              title={new Date(entry.ts).toLocaleTimeString()}
            >
              <span>⚙</span>
              <span>{entry.text}</span>
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button type="button" className="stream-activity-more" onClick={onToggleExpanded}>
            +{hiddenCount} more
          </button>
        )}
        {stream.expanded && total > ACTIVITY_TOP_N && (
          <button type="button" className="stream-activity-more" onClick={onToggleExpanded}>
            collapse
          </button>
        )}
      </div>
      {stream.accum && (
        <div className="stream-body">{renderWithMentions(stream.accum, channel)}</div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
