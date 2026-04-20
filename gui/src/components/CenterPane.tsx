import { useEffect, useRef, useState } from "react";
import { api, subscribeChatEvents, type ChatEvent } from "../api";
import type {
  Channel,
  ChannelEntry,
  ChatSession,
  Decision,
  PersistedChatMessage,
  TicketLedgerEntry,
} from "../types";

type Tab = "chat" | "board" | "decisions";

type Props = {
  channel: Channel | null;
  sessionId: string | null;
  refreshTick: number;
  onRefresh: () => void;
  onSessionCreated: (sessionId: string) => void;
};

type ActiveStream = {
  streamId: number;
  alias: string | null;
  accum: string;
  activity: string[];
};

export function CenterPane({
  channel,
  sessionId,
  refreshTick,
  onRefresh,
  onSessionCreated,
}: Props) {
  const [tab, setTab] = useState<Tab>("chat");
  const [feed, setFeed] = useState<ChannelEntry[]>([]);
  const [tickets, setTickets] = useState<TicketLedgerEntry[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [sessionMessages, setSessionMessages] = useState<PersistedChatMessage[]>(
    [],
  );
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [stream, setStream] = useState<ActiveStream | null>(null);

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    Promise.all([
      api.listFeed(channel.channelId, 200),
      api.listChannelTickets(channel.channelId),
      api.listChannelDecisions(channel.channelId),
      api.listSessions(channel.channelId),
    ]).then(([f, t, d, s]) => {
      if (cancelled) return;
      setFeed(f);
      setTickets(t);
      setDecisions(d);
      setSessions(s);
    });
    return () => {
      cancelled = true;
    };
  }, [channel?.channelId, refreshTick]);

  useEffect(() => {
    if (!channel || !sessionId) {
      setSessionMessages([]);
      return;
    }
    api.loadSession(channel.channelId, sessionId, 500).then(setSessionMessages);
  }, [channel?.channelId, sessionId, refreshTick]);

  // Subscribe once to chat-event stream and route by streamId.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeChatEvents((event) => {
      setStream((current) => {
        if (!current || event.streamId !== current.streamId) return current;
        return reduceStream(current, event);
      });
      if (event.kind === "done" || event.kind === "error") {
        // Refresh persisted messages so the stored assistant text shows up.
        onRefresh();
        setStream((current) =>
          current && current.streamId === event.streamId ? null : current,
        );
      }
    }).then((u) => (unlisten = u));
    return () => {
      if (unlisten) unlisten();
    };
  }, [onRefresh]);

  const activeSession = sessions.find((s) => s.sessionId === sessionId) ?? null;

  if (!channel) {
    return (
      <div className="panel">
        <div className="empty">Select or create a channel</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="tabs">
        <div
          className={`tab ${tab === "chat" ? "active" : ""}`}
          onClick={() => setTab("chat")}
        >
          Chat
        </div>
        <div
          className={`tab ${tab === "board" ? "active" : ""}`}
          onClick={() => setTab("board")}
        >
          Board ({tickets.length})
        </div>
        <div
          className={`tab ${tab === "decisions" ? "active" : ""}`}
          onClick={() => setTab("decisions")}
        >
          Decisions ({decisions.length})
        </div>
      </div>
      {tab === "chat" && (
        <ChatView
          channel={channel}
          sessionId={sessionId}
          activeSession={activeSession}
          sessionMessages={sessionMessages}
          feed={feed}
          stream={stream}
          onStartStream={setStream}
          onSessionCreated={onSessionCreated}
        />
      )}
      {tab === "board" && (
        <div className="content board-content">
          <BoardView tickets={tickets} />
        </div>
      )}
      {tab === "decisions" && (
        <div className="content">
          <DecisionsView decisions={decisions} />
        </div>
      )}
    </div>
  );
}

function reduceStream(current: ActiveStream, event: ChatEvent): ActiveStream {
  switch (event.kind) {
    case "chunk":
      return { ...current, accum: current.accum + event.text };
    case "activity":
      return { ...current, activity: [...current.activity, event.text] };
    default:
      return current;
  }
}

function ChatView({
  channel,
  sessionId,
  activeSession,
  sessionMessages,
  feed,
  stream,
  onStartStream,
  onSessionCreated,
}: {
  channel: Channel;
  sessionId: string | null;
  activeSession: ChatSession | null;
  sessionMessages: PersistedChatMessage[];
  feed: ChannelEntry[];
  stream: ActiveStream | null;
  onStartStream: (s: ActiveStream | null) => void;
  onSessionCreated: (sessionId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionMessages.length, feed.length, sessionId, stream?.accum.length]);

  return (
    <>
      <div className="content" ref={scrollRef}>
        {sessionId ? (
          <SessionMessages messages={sessionMessages} />
        ) : (
          <FeedView entries={feed} />
        )}
        {stream && (
          <div className={`feed-entry role-assistant streaming`}>
            <div className="feed-header">
              <span className="feed-author">
                {stream.alias ? `@${stream.alias}` : "assistant"}
              </span>
              <span className="stream-status">
                <span className="stream-dot" /> streaming
              </span>
            </div>
            <div className="stream-activity">
              {stream.activity.length === 0 ? (
                <div className="stream-activity-empty">
                  {stream.accum ? "writing response…" : "thinking…"}
                </div>
              ) : (
                stream.activity.slice(-5).map((a, i) => (
                  <div key={i} className="stream-activity-line">
                    · {a}
                  </div>
                ))
              )}
            </div>
            {stream.accum && (
              <div className="feed-content">{stream.accum}</div>
            )}
          </div>
        )}
      </div>
      <Composer
        channel={channel}
        sessionId={sessionId}
        activeSession={activeSession}
        streaming={!!stream}
        onStartStream={onStartStream}
        onSessionCreated={onSessionCreated}
      />
    </>
  );
}

function SessionMessages({ messages }: { messages: PersistedChatMessage[] }) {
  if (messages.length === 0)
    return <div className="empty">No messages in this session yet</div>;
  return (
    <>
      {messages.map((m, i) => (
        <div key={i} className={`feed-entry role-${m.role}`}>
          <div className="feed-header">
            <span className="feed-author">
              {m.agentAlias ? `@${m.agentAlias}` : m.role}
            </span>
            <span>{formatTime(m.timestamp)}</span>
          </div>
          <div className="feed-content">{m.content}</div>
        </div>
      ))}
    </>
  );
}

function FeedView({ entries }: { entries: ChannelEntry[] }) {
  if (entries.length === 0) return <div className="empty">No activity yet</div>;
  return (
    <>
      {entries.map((e) => (
        <div key={e.entryId} className={`feed-entry role-${e.type}`}>
          <div className="feed-header">
            <span className="feed-author">{e.fromDisplayName ?? e.type}</span>
            <span>{formatTime(e.createdAt)}</span>
          </div>
          <div className="feed-content">{e.content}</div>
        </div>
      ))}
    </>
  );
}

function Composer({
  channel,
  sessionId,
  activeSession,
  streaming,
  onStartStream,
  onSessionCreated,
}: {
  channel: Channel;
  sessionId: string | null;
  activeSession: ChatSession | null;
  streaming: boolean;
  onStartStream: (s: ActiveStream | null) => void;
  onSessionCreated: (sessionId: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(true);

  const send = async () => {
    const raw = text.trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      // Parse @alias prefix to route to a repo.
      const aliases = channel.repoAssignments.map((r) => r.alias);
      const { alias, body } = parseAliasPrefix(raw, aliases);
      const repo = alias
        ? channel.repoAssignments.find((r) => r.alias === alias)
        : null;
      const cwd = repo?.repoPath;
      const aliasKey = alias ?? "general";
      const claudeSessionId =
        activeSession?.claudeSessionIds?.[aliasKey] ?? undefined;

      let activeId = sessionId;
      if (!activeId) {
        const session = await api.createSession(channel.channelId, raw.slice(0, 60));
        activeId = session.sessionId;
        onSessionCreated(activeId);
      }

      const streamId = await api.startChat({
        channelId: channel.channelId,
        sessionId: activeId,
        message: body,
        alias: alias ?? undefined,
        cwd,
        claudeSessionId,
        autoApprove,
      });
      onStartStream({ streamId, alias, accum: "", activity: [] });
      setText("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const disabled = busy || streaming;

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          channel.repoAssignments.length > 0
            ? "Use @alias to target a repo · Enter to send · Shift+Enter newline"
            : "Type a message · Enter to send · Shift+Enter newline"
        }
        rows={2}
        disabled={disabled}
      />
      <div className="composer-controls">
        <label className="auto-approve" title="Pass --dangerously-skip-permissions to claude">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
          />
          auto-approve
        </label>
        <button
          className="primary"
          onClick={send}
          disabled={disabled || !text.trim()}
        >
          {streaming ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function parseAliasPrefix(
  message: string,
  aliases: string[],
): { alias: string | null; body: string } {
  const match = message.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]*)$/);
  if (!match) return { alias: null, body: message };
  const candidate = match[1];
  if (!aliases.includes(candidate)) return { alias: null, body: message };
  return { alias: candidate, body: match[2] };
}

// Canonical ticket statuses + display labels. "pending" shows as "Backlog"
// because that's what a kanban board reader expects.
const BOARD_COLUMNS: Array<{ status: string; label: string }> = [
  { status: "pending", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "executing", label: "Executing" },
  { status: "verifying", label: "Verifying" },
  { status: "retry", label: "Retry" },
  { status: "blocked", label: "Blocked" },
  { status: "completed", label: "Completed" },
  { status: "failed", label: "Failed" },
];

function BoardView({ tickets }: { tickets: TicketLedgerEntry[] }) {
  const [selected, setSelected] = useState<TicketLedgerEntry | null>(null);

  if (tickets.length === 0)
    return <div className="empty">No tickets in this channel</div>;

  const grouped: Record<string, TicketLedgerEntry[]> = {};
  for (const t of tickets) {
    const key = BOARD_COLUMNS.some((c) => c.status === t.status)
      ? t.status
      : "pending";
    (grouped[key] ||= []).push(t);
  }
  const visible = BOARD_COLUMNS.filter(
    (c) => (grouped[c.status]?.length ?? 0) > 0,
  );

  return (
    <>
      <div className="board-columns">
        {visible.map(({ status, label }) => (
          <div key={status} className="board-column">
            <h4>
              {label} ({grouped[status].length})
            </h4>
            <div className="board-column-body">
              {grouped[status].map((t) => (
                <div
                  key={t.ticketId}
                  className="ticket clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(t)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(t);
                    }
                  }}
                >
                  <div>{t.title}</div>
                  <div className="ticket-meta">
                    {t.specialty} · attempt {t.attempt}
                    {t.assignedAgentName ? ` · ${t.assignedAgentName}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {selected && (
        <TicketDetailModal
          ticket={selected}
          tickets={tickets}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function TicketDetailModal({
  ticket,
  tickets,
  onClose,
}: {
  ticket: TicketLedgerEntry;
  tickets: TicketLedgerEntry[];
  onClose: () => void;
}) {
  const deps = ticket.dependsOn.map((depId) => {
    const found = tickets.find((x) => x.ticketId === depId);
    return {
      id: depId,
      title: found?.title ?? "(not in this channel's ledger)",
      status: found?.status ?? "?",
    };
  });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal ticket-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">{ticket.title}</div>
        <div className="modal-body">
          <div className="detail-row">
            <span className="detail-label">ID</span>
            <code>{ticket.ticketId}</code>
          </div>
          <div className="detail-row">
            <span className="detail-label">Status</span>
            <span>{ticket.status}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Specialty</span>
            <span>{ticket.specialty}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Verification</span>
            <span>{ticket.verification}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Attempt</span>
            <span>{ticket.attempt}</span>
          </div>
          {ticket.assignedAgentName && (
            <div className="detail-row">
              <span className="detail-label">Assigned</span>
              <span>{ticket.assignedAgentName}</span>
            </div>
          )}
          {deps.length > 0 && (
            <div className="detail-row detail-row-block">
              <span className="detail-label">
                Depends on ({deps.length})
              </span>
              <ul className="dep-list">
                {deps.map((d) => (
                  <li key={d.id}>
                    <code>{d.id}</code>{" "}
                    <span className="dep-status">{d.status}</span>
                    <div className="dep-title">{d.title}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function DecisionsView({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0)
    return <div className="empty">No decisions recorded</div>;
  return (
    <>
      {decisions.map((d) => (
        <div key={d.decisionId} className="decision">
          <h4>{d.title}</h4>
          <div className="meta">
            {d.decidedByName} · {formatTime(d.createdAt)}
          </div>
          <p>{d.description}</p>
          {d.rationale && (
            <p>
              <strong>Why:</strong> {d.rationale}
            </p>
          )}
          {d.alternatives.length > 0 && (
            <p>
              <strong>Alternatives:</strong> {d.alternatives.join(", ")}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
