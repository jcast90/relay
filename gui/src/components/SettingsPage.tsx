import { useEffect, useState } from "react";
import { api } from "../api";
import type { GuiSettings, ProviderProfile } from "../types";
import { useAppearance, type AvatarStyle, type Density } from "../lib/appearance";

type Section = "ticketing" | "providers" | "appearance" | "general";

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
          className={`settings-nav-item ${section === "providers" ? "active" : ""}`}
          onClick={() => setSection("providers")}
        >
          Providers
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
        {section === "providers" && <ProvidersSection />}
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

type EnvRow = { key: string; value: string };

type DraftProfile = {
  id: string;
  displayName: string;
  adapter: "claude" | "codex";
  defaultModel: string;
  apiKeyEnvRef: string;
  envRows: EnvRow[];
};

const emptyDraft = (): DraftProfile => ({
  id: "",
  displayName: "",
  adapter: "claude",
  defaultModel: "",
  apiKeyEnvRef: "",
  envRows: [],
});

function ProvidersSection() {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftProfile>(emptyDraft());

  const refresh = async () => {
    try {
      const [list, def] = await Promise.all([
        api.listProviderProfiles(),
        api.getDefaultProviderProfileId(),
      ]);
      setProfiles(list);
      setDefaultId(def);
      setError(null);
    } catch (err) {
      setProfiles([]);
      setDefaultId(null);
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const addProfile = async () => {
    if (!draft.id.trim() || !draft.displayName.trim()) {
      setError("Profile id and display name are required.");
      return;
    }
    const envOverrides: Record<string, string> = {};
    for (const row of draft.envRows) {
      if (row.key.trim()) envOverrides[row.key.trim()] = row.value;
    }
    const now = new Date().toISOString();
    const next: ProviderProfile = {
      id: draft.id.trim(),
      displayName: draft.displayName.trim(),
      adapter: draft.adapter,
      envOverrides,
      apiKeyEnvRef: draft.apiKeyEnvRef.trim() || undefined,
      defaultModel: draft.defaultModel.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    setBusy(true);
    // Optimistic: drop the draft into the list so the table reflects the
    // add immediately; the refetch below reconciles against server truth.
    setProfiles((prev) => [...prev.filter((p) => p.id !== next.id), next]);
    try {
      await api.upsertProviderProfile(next);
      setDraft(emptyDraft());
      await refresh();
    } catch (err) {
      setError(String(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (id: string | null) => {
    const prev = defaultId;
    setDefaultId(id);
    try {
      await api.setDefaultProviderProfile(id);
      await refresh();
    } catch (err) {
      setDefaultId(prev);
      setError(String(err));
    }
  };

  const remove = async (id: string) => {
    const prev = profiles;
    setProfiles(prev.filter((p) => p.id !== id));
    try {
      await api.removeProviderProfile(id);
      await refresh();
    } catch (err) {
      setProfiles(prev);
      setError(String(err));
    }
  };

  const addEnvRow = () =>
    setDraft((d) => ({ ...d, envRows: [...d.envRows, { key: "", value: "" }] }));
  const updateEnvRow = (i: number, patch: Partial<EnvRow>) =>
    setDraft((d) => ({
      ...d,
      envRows: d.envRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    }));
  const removeEnvRow = (i: number) =>
    setDraft((d) => ({ ...d, envRows: d.envRows.filter((_, idx) => idx !== i) }));

  return (
    <>
      <h2>Providers</h2>
      <div className="warning" style={{ marginBottom: 16 }}>
        Profiles reference env var names — Relay never stores secrets.
      </div>
      <div className="settings-section">
        <h3>Profiles</h3>
        <p className="help">
          Each profile bundles an adapter (Claude or Codex CLI) with env overrides that get applied
          when Relay dispatches an agent. Set one as default, or pin a specific profile per channel
          in that channel's settings.
        </p>
        {profiles.length === 0 ? (
          <p className="help">
            <em>No profiles configured yet.</em>
          </p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--font-size-sm)",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-text-dim)" }}>
                <th style={{ padding: "6px 8px" }}>ID</th>
                <th style={{ padding: "6px 8px" }}>Name</th>
                <th style={{ padding: "6px 8px" }}>Adapter</th>
                <th style={{ padding: "6px 8px" }}>Model</th>
                <th style={{ padding: "6px 8px" }}>Key env var</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--color-paper-line)" }}>
                  <td style={{ padding: "6px 8px", fontFamily: "var(--font-mono)" }}>
                    {p.id}
                    {defaultId === p.id && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-accent-mint)",
                        }}
                      >
                        DEFAULT
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{p.displayName}</td>
                  <td style={{ padding: "6px 8px" }}>{p.adapter}</td>
                  <td style={{ padding: "6px 8px" }}>{p.defaultModel ?? "—"}</td>
                  <td
                    style={{
                      padding: "6px 8px",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {p.apiKeyEnvRef ?? "—"}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {defaultId !== p.id && (
                      <button onClick={() => makeDefault(p.id)} style={{ marginRight: 6 }}>
                        Make default
                      </button>
                    )}
                    <button className="danger" onClick={() => remove(p.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-section">
        <h3>Add profile</h3>
        <label>
          ID
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="minimax-pro"
          />
        </label>
        <label>
          Display name
          <input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            placeholder="MiniMax Pro"
          />
        </label>
        <label>
          Adapter
          <select
            value={draft.adapter}
            onChange={(e) => setDraft({ ...draft, adapter: e.target.value as "claude" | "codex" })}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </label>
        <label>
          Default model (optional)
          <input
            value={draft.defaultModel}
            onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
            placeholder="claude-sonnet-4"
          />
        </label>
        <label>
          API key env var (optional)
          <input
            value={draft.apiKeyEnvRef}
            onChange={(e) => setDraft({ ...draft, apiKeyEnvRef: e.target.value })}
            placeholder="MINIMAX_API_KEY"
          />
        </label>
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Env overrides</div>
          {draft.envRows.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
              <input
                placeholder="KEY"
                value={row.key}
                onChange={(e) => updateEnvRow(i, { key: e.target.value })}
                style={{ flex: 1 }}
              />
              <span>=</span>
              <input
                placeholder="value"
                value={row.value}
                onChange={(e) => updateEnvRow(i, { value: e.target.value })}
                style={{ flex: 2 }}
              />
              <button onClick={() => removeEnvRow(i)} className="danger">
                ✕
              </button>
            </div>
          ))}
          <button onClick={addEnvRow} style={{ marginTop: 4 }}>
            Add row
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={addProfile} disabled={busy}>
            {busy ? "Saving…" : "Add profile"}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Default</h3>
        <p className="help">
          Channels without a pinned profile fall back to this default at dispatch time. Clear it to
          fall through to <code>HARNESS_PROVIDER</code>.
        </p>
        <button onClick={() => makeDefault(null)} disabled={!defaultId}>
          Clear default
        </button>
      </div>

      {error && <div className="error">{error}</div>}
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
