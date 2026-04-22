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
    <div className="section">
      <div className="section-head">
        <h4>Sessions ({sessions.length})</h4>
        <button onClick={newSession} disabled={busy} title="New session">
          +
        </button>
      </div>
      {sessions.length === 0 && (
        <div className="row" style={{ color: "var(--text-muted)" }}>
          No sessions yet
        </div>
      )}
      {sessions.map((s) => (
        <div
          key={s.sessionId}
          className={`session-row ${s.sessionId === selectedSessionId ? "active" : ""}`}
          onClick={() => onSelect(s.sessionId)}
        >
          <div className="session-title">{s.title}</div>
          <div className="session-meta">
            {s.messageCount} msgs · {formatRelative(s.updatedAt)}
          </div>
        </div>
      ))}
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
