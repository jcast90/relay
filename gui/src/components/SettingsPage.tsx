import { useState } from "react";
import { api } from "../api";
import type { GuiSettings } from "../types";

type Section = "ticketing" | "general";

type Props = {
  settings: GuiSettings;
  onSaved: (next: GuiSettings) => void;
  onClose: () => void;
};

export function SettingsPage({ settings, onSaved, onClose }: Props) {
  const [section, setSection] = useState<Section>("ticketing");
  const [draft, setDraft] = useState<GuiSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: GuiSettings) => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(next);
      setDraft(next);
      onSaved(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <h3>Settings</h3>
        <button
          className={`settings-nav-item ${section === "ticketing" ? "active" : ""}`}
          onClick={() => setSection("ticketing")}
        >
          Ticketing
        </button>
        <button
          className={`settings-nav-item ${section === "general" ? "active" : ""}`}
          onClick={() => setSection("general")}
        >
          General
        </button>
        <div style={{ marginTop: 24 }}>
          <button onClick={onClose}>← Back to channels</button>
        </div>
      </aside>
      <div className="settings-main">
        {section === "ticketing" && (
          <TicketingSection draft={draft} onChange={save} saving={saving} error={error} />
        )}
        {section === "general" && (
          <GeneralSection />
        )}
      </div>
    </div>
  );
}

function TicketingSection({
  draft,
  onChange,
  saving,
  error,
}: {
  draft: GuiSettings;
  onChange: (next: GuiSettings) => void;
  saving: boolean;
  error: string | null;
}) {
  const providers: Array<{
    value: GuiSettings["ticketProvider"];
    title: string;
    desc: string;
  }> = [
    {
      value: "relay",
      title: "Relay-native",
      desc: "Tickets created by Relay's planner live directly in the channel board.",
    },
    {
      value: "linear",
      title: "Linear",
      desc:
        "Mirror issues from a Linear project onto the channel board. Polled on an interval.",
    },
    {
      value: "none",
      title: "None",
      desc: "Hide the board tab. Chat only.",
    },
  ];

  return (
    <>
      <h2>Ticketing</h2>
      <div className="settings-section">
        <h3>Provider</h3>
        <p className="help">
          Choose where tickets on the channel board come from. Applies globally.
        </p>
        <div className="settings-radio-group">
          {providers.map((p) => (
            <label
              key={p.value}
              className={draft.ticketProvider === p.value ? "selected" : ""}
            >
              <input
                type="radio"
                name="ticket-provider"
                checked={draft.ticketProvider === p.value}
                onChange={() => onChange({ ...draft, ticketProvider: p.value })}
              />
              <span>
                <span className="settings-radio-title">{p.title}</span>
                <span className="settings-radio-desc" style={{ display: "block" }}>
                  {p.desc}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {draft.ticketProvider === "linear" && (
        <div className="settings-section">
          <h3>Linear</h3>
          <p className="help">
            Relay polls Linear every{" "}
            <strong>{draft.linearPollSeconds}s</strong> and mirrors issues tagged to the channel.
          </p>
          <label>
            API token
            <input
              type="password"
              value={draft.linearApiToken}
              onChange={(e) =>
                onChange({ ...draft, linearApiToken: e.target.value })
              }
              placeholder="lin_api_…"
            />
          </label>
          <label>
            Workspace slug
            <input
              value={draft.linearWorkspace}
              onChange={(e) =>
                onChange({ ...draft, linearWorkspace: e.target.value })
              }
              placeholder="acme-inc"
            />
          </label>
          <label>
            Poll interval (seconds)
            <input
              type="number"
              min={10}
              value={draft.linearPollSeconds}
              onChange={(e) =>
                onChange({ ...draft, linearPollSeconds: Number(e.target.value) || 30 })
              }
            />
          </label>
        </div>
      )}

      {saving && <div className="warning">Saving…</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}

function GeneralSection() {
  return (
    <>
      <h2>General</h2>
      <div className="settings-section">
        <h3>About Relay</h3>
        <p className="help">
          Relay runs coding agents across your registered workspaces. Channels are repo-scoped
          execution contexts; each (channel, repo) pair has its own agent instance.
        </p>
      </div>
    </>
  );
}
