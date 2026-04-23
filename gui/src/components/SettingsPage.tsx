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

// Two mutually-exclusive ways a provider can authenticate. cli-login
// means the underlying CLI manages its own auth via `claude login` /
// `codex login` — Relay forwards CLAUDE_CONFIG_DIR / CODEX_HOME so the
// cached session just works, no API key env var needed. api-key means
// the user exports the key in their shell and the profile references
// it by name via apiKeyEnvRef.
type AuthMode = "cli-login" | "api-key";

type DraftProfile = {
  id: string;
  displayName: string;
  adapter: "claude" | "codex";
  defaultModel: string;
  apiKeyEnvRef: string;
  envRows: EnvRow[];
  presetId: string;
  authMode: AuthMode;
};

const emptyDraft = (): DraftProfile => ({
  id: "",
  displayName: "",
  adapter: "claude",
  defaultModel: "",
  apiKeyEnvRef: "",
  envRows: [],
  presetId: "",
  authMode: "api-key",
});

// Mirror of `isLikelySecretValue` from src/domain/provider-profile.ts so
// we can fail fast in the GUI before round-tripping through Tauri. Keep
// this list synced with the canonical TS version — CLI is still the
// source of truth, this is just UX.
function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  const prefixes = [
    "sk-",
    "sk_",
    "pk-",
    "anthropic_",
    "anthropic-",
    "sess-",
    "sess_",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "aws_",
    "akia",
    "bearer ",
  ];
  if (prefixes.some((p) => lower.startsWith(p))) return true;
  if (/^[A-Za-z0-9_\-+/=]{32,}$/.test(trimmed)) return true;
  return false;
}

type ProviderPreset = {
  id: string;
  displayName: string;
  adapter: "claude" | "codex";
  apiKeyEnvRef: string;
  envOverrides: Record<string, string>;
  models: string[];
  description: string;
  /**
   * Auth modes this provider supports. Order matters — the first entry
   * is the default when the user picks the preset. Providers with only
   * `api-key` hide the auth-mode selector.
   */
  supportedAuthModes: AuthMode[];
  /**
   * Shell command a user runs to authenticate via the provider's CLI
   * flow (when {@link supportedAuthModes} includes `cli-login`). Shown
   * as inline help, e.g. "Run `claude login` in a terminal first."
   */
  cliLoginCommand?: string;
};

// Known-good provider presets. Picking one auto-fills id, displayName,
// adapter, apiKeyEnvRef, and envOverrides so the user doesn't have to
// remember which base URL belongs to which vendor. Model lists are
// suggestions only — every provider rolls new models constantly, so the
// model <select> always exposes a "Custom…" escape hatch. If a suggested
// id 404s, the user types the current id and saves.
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    adapter: "claude",
    apiKeyEnvRef: "ANTHROPIC_API_KEY",
    envOverrides: {},
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
    description: "Claude Max / Pro / API",
    supportedAuthModes: ["cli-login", "api-key"],
    cliLoginCommand: "claude login",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    adapter: "codex",
    apiKeyEnvRef: "OPENAI_API_KEY",
    envOverrides: {},
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    description: "ChatGPT Plus / Team / API",
    supportedAuthModes: ["cli-login", "api-key"],
    cliLoginCommand: "codex login",
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    adapter: "codex",
    apiKeyEnvRef: "MINIMAX_API_KEY",
    envOverrides: { OPENAI_BASE_URL: "https://api.minimax.io/v1" },
    models: ["MiniMax-M2"],
    description: "OpenAI-compatible MiniMax endpoint",
    supportedAuthModes: ["api-key"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    adapter: "codex",
    apiKeyEnvRef: "OPENROUTER_API_KEY",
    envOverrides: { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" },
    models: [
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4",
      "openai/gpt-5",
      "deepseek/deepseek-chat",
    ],
    description: "Multi-model gateway",
    supportedAuthModes: ["api-key"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    adapter: "codex",
    apiKeyEnvRef: "DEEPSEEK_API_KEY",
    envOverrides: { OPENAI_BASE_URL: "https://api.deepseek.com/v1" },
    models: ["deepseek-chat", "deepseek-coder"],
    description: "OpenAI-compatible DeepSeek endpoint",
    supportedAuthModes: ["api-key"],
  },
  {
    id: "groq",
    displayName: "Groq",
    adapter: "codex",
    apiKeyEnvRef: "GROQ_API_KEY",
    envOverrides: { OPENAI_BASE_URL: "https://api.groq.com/openai/v1" },
    models: ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile"],
    description: "Fast Groq inference",
    supportedAuthModes: ["api-key"],
  },
  {
    id: "together",
    displayName: "Together",
    adapter: "codex",
    apiKeyEnvRef: "TOGETHER_API_KEY",
    envOverrides: { OPENAI_BASE_URL: "https://api.together.xyz/v1" },
    models: ["Qwen/Qwen2.5-Coder-32B-Instruct", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    description: "Together AI multi-model platform",
    supportedAuthModes: ["api-key"],
  },
  {
    id: "litellm",
    displayName: "LiteLLM (local)",
    adapter: "codex",
    apiKeyEnvRef: "OPENAI_API_KEY",
    envOverrides: { OPENAI_BASE_URL: "http://localhost:4000" },
    models: [],
    description: "LiteLLM proxy on localhost",
    supportedAuthModes: ["api-key"],
  },
];

const CUSTOM_PRESET_ID = "__custom__";
const MODEL_CUSTOM_SENTINEL = "__model_custom__";

function ModelField({
  draft,
  onChange,
}: {
  draft: DraftProfile;
  onChange: (next: DraftProfile) => void;
}) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === draft.presetId);
  const suggestions = preset?.models ?? [];

  // Show a <select> when the preset has suggestions AND the current value
  // matches one of them; otherwise fall back to a free-form text input.
  const valueMatchesSuggestion = !!draft.defaultModel && suggestions.includes(draft.defaultModel);
  const [customMode, setCustomMode] = useState(
    () => suggestions.length === 0 || (!!draft.defaultModel && !valueMatchesSuggestion)
  );

  useEffect(() => {
    // Re-evaluate custom-mode when the preset changes. Dep is only
    // `draft.presetId` on purpose: `applyPresetToDraft` resets
    // `draft.defaultModel` in the same setState, so by the time this
    // effect runs the closure's `suggestions` and `defaultModel` are
    // already from the new preset. Adding `draft.defaultModel` as a dep
    // would fire the effect on every keystroke in the custom-mode input
    // and flip the UI back out of custom-mode mid-typing.
    if (suggestions.length === 0) {
      setCustomMode(true);
    } else if (draft.defaultModel && !suggestions.includes(draft.defaultModel)) {
      setCustomMode(true);
    } else {
      setCustomMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.presetId]);

  if (customMode) {
    return (
      <label className="provider-form-field">
        <span>Default model</span>
        <input
          value={draft.defaultModel}
          onChange={(e) => onChange({ ...draft, defaultModel: e.target.value })}
          placeholder="e.g. claude-sonnet-4-6"
        />
        {suggestions.length > 0 && (
          <button
            type="button"
            className="provider-form-inline-action"
            onClick={() => {
              setCustomMode(false);
              onChange({ ...draft, defaultModel: suggestions[0] ?? "" });
            }}
          >
            ← Use a suggested model
          </button>
        )}
      </label>
    );
  }

  return (
    <label className="provider-form-field">
      <span>Default model</span>
      <select
        value={draft.defaultModel || ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === MODEL_CUSTOM_SENTINEL) {
            setCustomMode(true);
            onChange({ ...draft, defaultModel: "" });
            return;
          }
          onChange({ ...draft, defaultModel: v });
        }}
      >
        <option value="">(none — adapter default)</option>
        {suggestions.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={MODEL_CUSTOM_SENTINEL}>Custom…</option>
      </select>
    </label>
  );
}

function applyPresetToDraft(preset: ProviderPreset, existingId: string): DraftProfile {
  // Keep the user's id if they've typed something other than the previous
  // preset's default id — covers the "openai-prod" case where someone
  // picks OpenAI, renames the id, then switches to OpenRouter. Falls back
  // to the preset's own id when the draft is blank or the user picked the
  // same preset twice.
  const nextId = existingId && existingId !== preset.id ? existingId : preset.id;
  const defaultAuthMode = preset.supportedAuthModes[0];
  return {
    id: nextId,
    displayName: preset.displayName,
    adapter: preset.adapter,
    defaultModel: preset.models[0] ?? "",
    apiKeyEnvRef: preset.apiKeyEnvRef,
    envRows: Object.entries(preset.envOverrides).map(([key, value]) => ({ key, value })),
    presetId: preset.id,
    authMode: defaultAuthMode,
  };
}

function AuthSection({
  draft,
  onChange,
}: {
  draft: DraftProfile;
  onChange: (next: DraftProfile) => void;
}) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === draft.presetId);
  const modes = preset?.supportedAuthModes ?? ["cli-login", "api-key"];
  const showSelector = modes.length > 1;

  return (
    <>
      {showSelector && (
        <div className="provider-form-row">
          <label className="provider-form-field">
            <span>Authentication</span>
            <select
              value={draft.authMode}
              onChange={(e) =>
                onChange({
                  ...draft,
                  authMode: e.target.value as AuthMode,
                  // Entering api-key mode with a blank ref? Prefill from
                  // the preset so the user sees what to type.
                  apiKeyEnvRef:
                    e.target.value === "api-key" && !draft.apiKeyEnvRef && preset
                      ? preset.apiKeyEnvRef
                      : draft.apiKeyEnvRef,
                })
              }
            >
              <option value="cli-login">Subscription / CLI login (no API key)</option>
              <option value="api-key">API key from env var</option>
            </select>
          </label>
        </div>
      )}

      {draft.authMode === "cli-login" && preset?.cliLoginCommand && (
        <div className="provider-form-row">
          <div className="provider-form-field provider-form-field-full">
            <span>Login command</span>
            <small className="provider-form-hint">
              Relay will use your existing {preset.displayName} login. Run{" "}
              <code>{preset.cliLoginCommand}</code> in a terminal once to cache the credentials; the{" "}
              {preset.adapter} CLI picks them up automatically on every dispatch.
            </small>
          </div>
        </div>
      )}

      {draft.authMode === "api-key" && (
        <div className="provider-form-row">
          <label className="provider-form-field">
            <span>API key env var</span>
            <input
              value={draft.apiKeyEnvRef}
              onChange={(e) => onChange({ ...draft, apiKeyEnvRef: e.target.value })}
              placeholder="e.g. MINIMAX_API_KEY"
            />
            <small className="provider-form-hint">
              Relay reads the secret from this env var in your shell at dispatch time. The key value
              itself is never persisted in the profile.
            </small>
          </label>
        </div>
      )}
    </>
  );
}

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
    // Client-side mirror of the CLI's isLikelySecretValue check. We still
    // rely on the CLI to be the source of truth (it rejects at write
    // time), but surfacing the rule here gives users an immediate
    // explanation instead of a Tauri error popup with a stringified
    // reason buried in it.
    for (const [key, value] of Object.entries(envOverrides)) {
      if (looksLikeSecret(value)) {
        setError(
          `Env override "${key}" looks like a raw secret. Move the value to your shell and reference it via the "API key env var" field instead.`
        );
        return;
      }
    }
    const now = new Date().toISOString();
    const next: ProviderProfile = {
      id: draft.id.trim(),
      displayName: draft.displayName.trim(),
      adapter: draft.adapter,
      envOverrides,
      // cli-login mode intentionally drops any leftover apiKeyEnvRef so
      // the saved profile reflects "no env-var auth needed" rather than
      // pointing at a stale env var the dispatch path would try to pass
      // through.
      apiKeyEnvRef:
        draft.authMode === "cli-login" ? undefined : draft.apiKeyEnvRef.trim() || undefined,
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
                <th style={{ padding: "6px 8px" }}>Auth</th>
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
                      fontFamily: p.apiKeyEnvRef ? "var(--font-mono)" : "inherit",
                      color: p.apiKeyEnvRef ? "inherit" : "var(--color-text-muted)",
                    }}
                  >
                    {p.apiKeyEnvRef ?? "CLI login"}
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
        <p className="help">
          Pick a template to pre-fill the common fields, then adjust the id / model as needed.
          "Custom" leaves everything blank for fully manual setup.
        </p>

        <div className="provider-form">
          <div className="provider-form-row">
            <label className="provider-form-field">
              <span>Template</span>
              <select
                value={draft.presetId}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id === "") return;
                  if (id === CUSTOM_PRESET_ID) {
                    setDraft({ ...emptyDraft(), presetId: CUSTOM_PRESET_ID });
                    return;
                  }
                  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
                  if (preset) setDraft(applyPresetToDraft(preset, draft.id));
                }}
              >
                <option value="">(choose a template)</option>
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} — {p.description}
                  </option>
                ))}
                <option value={CUSTOM_PRESET_ID}>Custom…</option>
              </select>
            </label>
          </div>

          <div className="provider-form-row">
            <label className="provider-form-field">
              <span>Profile ID</span>
              <input
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="e.g. anthropic or openai-prod"
              />
            </label>
            <label className="provider-form-field">
              <span>Display name</span>
              <input
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                placeholder="Shown in channel dropdown"
              />
            </label>
          </div>

          <div className="provider-form-row">
            <label className="provider-form-field">
              <span>Adapter</span>
              <select
                value={draft.adapter}
                onChange={(e) =>
                  setDraft({ ...draft, adapter: e.target.value as "claude" | "codex" })
                }
              >
                <option value="claude">Claude CLI (Anthropic-compatible)</option>
                <option value="codex">Codex CLI (OpenAI-compatible)</option>
              </select>
            </label>
            <ModelField draft={draft} onChange={setDraft} />
          </div>

          <AuthSection draft={draft} onChange={setDraft} />

          <div className="provider-form-row">
            <div className="provider-form-field provider-form-field-full">
              <span>Env overrides</span>
              <small className="provider-form-hint">
                Extra env vars passed to the CLI subprocess (e.g. <code>OPENAI_BASE_URL</code>).
                Leave the value blank for secrets — use the API key env var field above instead.
              </small>
              <div className="provider-env-rows">
                {draft.envRows.map((row, i) => (
                  <div key={i} className="provider-env-row">
                    <input
                      placeholder="KEY"
                      value={row.key}
                      onChange={(e) => updateEnvRow(i, { key: e.target.value })}
                      className="provider-env-key"
                    />
                    <span className="provider-env-sep">=</span>
                    <input
                      placeholder="value"
                      value={row.value}
                      onChange={(e) => updateEnvRow(i, { value: e.target.value })}
                      className="provider-env-value"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvRow(i)}
                      className="danger provider-env-remove"
                      aria-label="Remove env override"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addEnvRow} className="provider-env-add">
                  + Add env override
                </button>
              </div>
            </div>
          </div>

          <div className="provider-form-actions">
            <button onClick={addProfile} disabled={busy}>
              {busy ? "Saving…" : "Save profile"}
            </button>
          </div>
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
