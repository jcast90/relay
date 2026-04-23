import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChatSession } from "../types";

type Props = {
  channelId: string | null;
  selectedSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
  refreshTick: number;
};

export function SessionList({ channelId, selectedSessionId, onSelect, refreshTick }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!channelId) {
      setSessions([]);
      return;
    }
    api.listSessions(channelId).then(setSessions);
  }, [channelId, refreshTick]);

  if (!channelId) return null;

  const newSession = async () => {
    setBusy(true);
    try {
      const session = await api.createSession(channelId, "New conversation");
      const updated = await api.listSessions(channelId);
      setSessions(updated);
      onSelect(session.sessionId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rail-session-list">
      <div className="rail-session-head">
        <span className="rail-section-title">Sessions · {sessions.length}</span>
        <button
          type="button"
          className="rail-session-new"
          onClick={newSession}
          disabled={busy}
          title="New session"
        >
          +
        </button>
      </div>
      {sessions.length === 0 && (
        <div className="rail-empty">
          No sessions yet — send a message to start one.
        </div>
      )}
      <div className="rail-session-body">
        {selectedSessionId && (
          <button
            type="button"
            className="rail-session-back"
            onClick={() => onSelect(null)}
            title="Exit the session and return to the full channel feed"
          >
            ← Back to channel feed
          </button>
        )}
        {sessions.map((s) => {
          const active = s.sessionId === selectedSessionId;
          return (
            <button
              type="button"
              key={s.sessionId}
              className={`rail-session-card ${active ? "active" : ""}`}
              onClick={() => onSelect(s.sessionId)}
            >
              <div className="rail-session-title">{s.title || "Untitled session"}</div>
              <div className="rail-session-meta">
                <span>{s.messageCount} msgs</span>
                <span>·</span>
                <span>{formatRelative(s.updatedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const diff = Date.now() - d;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return iso;
  }
}
