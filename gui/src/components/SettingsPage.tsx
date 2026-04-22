import { useState } from "react";
import { api } from "../api";
import type { GuiSettings } from "../types";
import { useAppearance, type AvatarStyle, type Density } from "../lib/appearance";

type Section = "ticketing" | "appearance" | "general";

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
          className={`settings-nav-item ${section === "appearance" ? "active" : ""}`}
          onClick={() => setSection("appearance")}
        >
          Appearance
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
        {section === "appearance" && <AppearanceSection />}
        {section === "general" && <GeneralSection />}
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
      desc: "Mirror issues from a Linear project onto the channel board. Polled on an interval.",
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
            <label key={p.value} className={draft.ticketProvider === p.value ? "selected" : ""}>
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
            Relay polls Linear every <strong>{draft.linearPollSeconds}s</strong> and mirrors issues
            tagged to the channel.
          </p>
          <label>
            API token
            <input
              type="password"
              value={draft.linearApiToken}
              onChange={(e) => onChange({ ...draft, linearApiToken: e.target.value })}
              placeholder="lin_api_…"
            />
          </label>
          <label>
            Workspace slug
            <input
              value={draft.linearWorkspace}
              onChange={(e) => onChange({ ...draft, linearWorkspace: e.target.value })}
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

function AppearanceSection() {
  const [appearance, setAppearance] = useAppearance();
  const avatarStyles: Array<{ value: AvatarStyle; title: string; desc: string }> = [
    {
      value: "glyph",
      title: "Glyph",
      desc: "Deterministic symbols (◆ ▲ ● ■) hashed from each agent's id.",
    },
    {
      value: "initial",
      title: "Initial",
      desc: "First letter of the agent's display name. Simpler, less distinctive.",
    },
  ];
  const densities: Array<{ value: Density; title: string; desc: string }> = [
    { value: "compact", title: "Compact", desc: "Tighter padding for small windows." },
    { value: "medium", title: "Medium", desc: "Default — Slack-equivalent spacing." },
    { value: "spacious", title: "Spacious", desc: "Airier for larger displays." },
  ];

  return (
    <>
      <h2>Appearance</h2>
      <div className="settings-section">
        <h3>Avatar style</h3>
        <p className="help">How agent avatars render across message feeds and the header stack.</p>
        <div className="settings-radio-group">
          {avatarStyles.map((s) => (
            <label key={s.value} className={appearance.avatarStyle === s.value ? "selected" : ""}>
              <input
                type="radio"
                name="avatar-style"
                checked={appearance.avatarStyle === s.value}
                onChange={() => setAppearance({ ...appearance, avatarStyle: s.value })}
              />
              <span>
                <span className="settings-radio-title">{s.title}</span>
                <span className="settings-radio-desc" style={{ display: "block" }}>
                  {s.desc}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="settings-section">
        <h3>Density</h3>
        <p className="help">Spacing scale for rails, messages, and drawers.</p>
        <div className="settings-radio-group">
          {densities.map((d) => (
            <label key={d.value} className={appearance.density === d.value ? "selected" : ""}>
              <input
                type="radio"
                name="density"
                checked={appearance.density === d.value}
                onChange={() => setAppearance({ ...appearance, density: d.value })}
              />
              <span>
                <span className="settings-radio-title">{d.title}</span>
                <span className="settings-radio-desc" style={{ display: "block" }}>
                  {d.desc}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
