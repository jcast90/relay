import { useMemo, useState } from "react";
import type { GuiSettings, TicketLedgerEntry } from "../types";

type Props = {
  tickets: TicketLedgerEntry[];
  settings: GuiSettings | null;
};

type View = "list" | "kanban";

const STATUS_ORDER = [
  "pending",
  "ready",
  "executing",
  "verifying",
  "retry",
  "blocked",
  "completed",
  "failed",
];

export function BoardView({ tickets, settings }: Props) {
  const [view, setView] = useState<View>("list");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<TicketLedgerEntry | null>(null);

  const showLinearBadge = settings?.ticketProvider === "linear";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (q && !t.title.toLowerCase().includes(q) && !t.ticketId.toLowerCase().includes(q)) {
        return false;
      }
      if (statusFilter.size > 0 && !statusFilter.has(t.status)) return false;
      return true;
    });
  }, [tickets, query, statusFilter]);

  const toggleStatus = (s: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  if (tickets.length === 0) {
    return <div className="chat-empty">No tickets in this channel</div>;
  }

  return (
    <div className="chat-scroll board" style={{ display: "flex", flexDirection: "column" }}>
      <div className="board-toolbar">
        <input
          placeholder="Search tickets…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              style={{
                fontSize: "var(--font-size-xs)",
                padding: "2px 8px",
                textTransform: "capitalize",
                ...(statusFilter.has(s)
                  ? {
                      background: "var(--color-accent-coral)",
                      borderColor: "var(--color-accent-coral)",
                      color: "#fff",
                    }
                  : {}),
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="board-view-toggle">
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
            List
          </button>
          <button className={view === "kanban" ? "active" : ""} onClick={() => setView("kanban")}>
            Kanban
          </button>
        </div>
      </div>

      {view === "list" ? (
        <div className="board-list">
          {filtered.map((t) => (
            <div key={t.ticketId} className="board-list-row" onClick={() => setSelected(t)}>
              <span className="ticket-id">{t.ticketId}</span>
              <span className={`status-pill status-${statusKey(t.status)}`}>{t.status}</span>
              <span className="ticket-title">
                {t.title}
                {showLinearBadge && t.source === "linear" && t.linearIdentifier && (
                  <span className="linear-tag">Linear · {t.linearIdentifier}</span>
                )}
              </span>
              <span className="agent-chip">
                {t.assignedAlias ? `@${t.assignedAlias}` : t.assignedAgentName ?? "—"}
              </span>
              <span className="agent-chip">
                {t.linearIdentifier ? t.linearIdentifier : `#${t.attempt}`}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <KanbanView tickets={filtered} onSelect={setSelected} showLinearBadge={showLinearBadge} />
      )}

      {selected && <TicketDetailModal ticket={selected} tickets={tickets} onClose={() => setSelected(null)} />}
    </div>
  );
}

function KanbanView({
  tickets,
  onSelect,
  showLinearBadge,
}: {
  tickets: TicketLedgerEntry[];
  onSelect: (t: TicketLedgerEntry) => void;
  showLinearBadge: boolean;
}) {
  const grouped: Record<string, TicketLedgerEntry[]> = {};
  for (const t of tickets) {
    const key = STATUS_ORDER.includes(t.status) ? t.status : "pending";
    (grouped[key] ||= []).push(t);
  }
  const visible = STATUS_ORDER.filter((s) => (grouped[s]?.length ?? 0) > 0);
  return (
    <div className="board-columns">
      {visible.map((s) => (
        <div key={s} className="board-column">
          <h4>
            {s} ({grouped[s].length})
          </h4>
          <div className="board-column-body">
            {grouped[s].map((t) => (
              <div key={t.ticketId} className="ticket-card" onClick={() => onSelect(t)}>
                {showLinearBadge && t.source === "linear" && t.linearIdentifier && (
                  <div className="linear-tag" style={{ marginBottom: 4 }}>
                    Linear · {t.linearIdentifier}
                  </div>
                )}
                <div className="title">{t.title}</div>
                <div className="meta">
                  {t.specialty}
                  {t.assignedAlias ? ` · @${t.assignedAlias}` : ""}
                  {t.assignedAgentName ? ` · ${t.assignedAgentName}` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
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
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {ticket.title}
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <DetailRow label="ID">
            <code>{ticket.ticketId}</code>
          </DetailRow>
          <DetailRow label="Status">
            <span className={`status-pill status-${statusKey(ticket.status)}`}>{ticket.status}</span>
          </DetailRow>
          <DetailRow label="Specialty">{ticket.specialty}</DetailRow>
          <DetailRow label="Verification">{ticket.verification}</DetailRow>
          <DetailRow label="Attempt">{ticket.attempt}</DetailRow>
          {ticket.assignedAgentName && <DetailRow label="Assigned">{ticket.assignedAgentName}</DetailRow>}
          {ticket.assignedAlias && <DetailRow label="Routed to">@{ticket.assignedAlias}</DetailRow>}
          {ticket.source === "linear" && ticket.linearUrl && (
            <DetailRow label="Linear">
              <a
                href={ticket.linearUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tracked-pr-link"
              >
                {ticket.linearIdentifier ?? "Open"}
              </a>
            </DetailRow>
          )}
          {deps.length > 0 && (
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", color: "var(--color-text-dim)", marginBottom: 6 }}>
                Depends on ({deps.length})
              </div>
              <ul style={{ padding: 0, margin: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                {deps.map((d) => (
                  <li
                    key={d.id}
                    style={{
                      padding: 8,
                      background: "var(--color-paper-alt)",
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  >
                    <code>{d.id}</code>
                    <span style={{ marginLeft: 8, color: "var(--color-text-muted)" }}>{d.status}</span>
                    <div style={{ marginTop: 2 }}>{d.title}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, fontSize: 13 }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", color: "var(--color-text-dim)" }}>
        {label}
      </span>
      <span>{children}</span>
    </div>
  );
}

function statusKey(s: string): string {
  return STATUS_ORDER.includes(s) ? s : "pending";
}
