/**
 * Tracker config schema for `~/.relay/config.json`. Seventh slice of the
 * v0.2 tracker work (PR G / #186). Surfaces the integration choices
 * users make at install time as a typed, validated block; PR H (#187)
 * documents it for humans.
 *
 * Default behavior preserves Relay's offline-first posture: a config
 * without a `tracker` block resolves to the `relay_native` provider,
 * matching every Relay deployment that existed before v0.2 lands. No
 * migration step is required — old configs continue to work.
 */
import { z } from "zod";

export const TrackerProviderNameSchema = z.enum([
  "github_projects",
  "linear",
  "github_issues",
  "relay_native",
]);

export type TrackerProviderName = z.infer<typeof TrackerProviderNameSchema>;

/**
 * How project titles are derived from a channel. Either "use the
 * channel's primary repo alias verbatim" (matches the convention from
 * `docs/design/tracker-projects-mapping.md`) or "use a fixed string for
 * every channel" (single shared project, useful for small teams that
 * don't want a project per repo).
 */
export const ProjectNamingSchema = z.union([
  z.literal("per_primary_repo"),
  z.object({ fixed: z.string().min(1) }),
]);
export type ProjectNaming = z.infer<typeof ProjectNamingSchema>;

export const GitHubProjectsConfigSchema = z.object({
  /** GitHub login (user or org) that hosts the project. */
  owner: z.string().min(1),
  /**
   * `user` for personal projects, `organization` for shared. Drives
   * which GraphQL root the client queries. Default `user` matches the
   * common solo workflow.
   */
  ownerType: z.enum(["user", "organization"]).default("user"),
  /** See `ProjectNamingSchema`. Defaults to per-primary-repo. */
  project_naming: ProjectNamingSchema.default("per_primary_repo"),
  /**
   * Native parent-child hierarchy (`parent_draft_item`, the design-doc
   * choice) vs the custom-field fallback. The custom-field path caps
   * at ~50 channels per project — `rly doctor` warns when this is set.
   */
  epic_model: z.enum(["parent_draft_item", "custom_field"]).default("parent_draft_item"),
  /**
   * When false, the integration creates real GitHub Issues instead of
   * draft items. Strongly discouraged: real Issues clutter the bug
   * tracker with feature-planning rows and break the
   * Relay-authoritative drift contract. Default `true`.
   */
  use_draft_items: z.boolean().default(true),
  /** Sync-worker tick interval. Wired by issue #194. */
  sync_interval_seconds: z.number().int().min(5).max(3600).default(30),
  /**
   * Threshold below which the sync worker pauses new work for the
   * current tick. Matches the default in
   * `src/integrations/github-projects/sync-worker.ts`.
   */
  min_rate_limit_budget: z.number().int().min(0).default(200),
});
export type GitHubProjectsConfig = z.infer<typeof GitHubProjectsConfigSchema>;

export const LinearConfigSchema = z.object({
  /** Linear team prefix, e.g. `REL` for `REL-123` issue keys. */
  team_key: z.string().min(1),
  project_naming: ProjectNamingSchema.default("per_primary_repo"),
});
export type LinearConfig = z.infer<typeof LinearConfigSchema>;

export const GitHubIssuesConfigSchema = z.object({
  /**
   * When false (the default and the recommended posture), Relay does
   * not mirror tickets onto GitHub Issues. Existing GitHub Issue URL
   * pasting via the classifier still works — this flag is only about
   * outbound projection.
   */
  enabled: z.boolean().default(false),
});
export type GitHubIssuesConfig = z.infer<typeof GitHubIssuesConfigSchema>;

export const RelayNativeConfigSchema = z.object({
  /**
   * Always-on offline fallback. Disabling this is a footgun — the
   * channel board still works regardless of external-tracker status.
   */
  enabled: z.boolean().default(true),
});
export type RelayNativeConfig = z.infer<typeof RelayNativeConfigSchema>;

export const TrackerProvidersSchema = z
  .object({
    github_projects: GitHubProjectsConfigSchema.optional(),
    linear: LinearConfigSchema.optional(),
    github_issues: GitHubIssuesConfigSchema.default({ enabled: false }),
    relay_native: RelayNativeConfigSchema.default({ enabled: true }),
  })
  .default({});
export type TrackerProviders = z.infer<typeof TrackerProvidersSchema>;

export const TrackerConfigSchema = z.object({
  default: TrackerProviderNameSchema.default("relay_native"),
  providers: TrackerProvidersSchema,
});
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

/**
 * Default tracker config for users who haven't opted into any external
 * tracker. Matches the migration shape: `relay_native` always-on,
 * other provider blocks absent. Configs predating v0.2 deserialize to
 * exactly this value via `TrackerConfigSchema.parse({})`.
 */
export const DEFAULT_TRACKER_CONFIG: TrackerConfig = TrackerConfigSchema.parse({});

/**
 * Parse a raw `tracker` JSON value (or `undefined` when the config
 * file predates v0.2) into a validated `TrackerConfig`. Throws a zod
 * error on malformed input — callers should surface that to the user
 * since proceeding with bad config silently would be worse than
 * crashing the CLI.
 */
export function parseTrackerConfig(input: unknown): TrackerConfig {
  if (input === undefined || input === null) {
    return DEFAULT_TRACKER_CONFIG;
  }
  return TrackerConfigSchema.parse(input);
}

/**
 * Resolve the effective tracker provider for a channel, taking a
 * per-channel `trackerOverride` into account. The override is honored
 * even when the global default is `relay_native` — that's the path
 * for "everything stays Relay-native, except this one channel".
 */
export function resolveProviderForChannel(
  config: TrackerConfig,
  override?: TrackerProviderName
): TrackerProviderName {
  return override ?? config.default;
}

export interface TrackerConfigDiagnostic {
  level: "ok" | "warn" | "error";
  message: string;
}

/**
 * Run sanity checks against a parsed tracker config. Used by `rly
 * doctor` to surface common misconfigurations before they bite at
 * runtime. Pure — no I/O, no env reads — so it can be unit-tested
 * cheaply.
 */
export function diagnoseTrackerConfig(config: TrackerConfig): TrackerConfigDiagnostic[] {
  const diagnostics: TrackerConfigDiagnostic[] = [];
  const def = config.default;
  const providers = config.providers;

  // Default must point at a provider whose block is present and enabled.
  if (def === "github_projects" && !providers.github_projects) {
    diagnostics.push({
      level: "error",
      message:
        'tracker.default is "github_projects" but tracker.providers.github_projects is missing. ' +
        "Add an `owner` (and optionally `ownerType`) under that block.",
    });
  }
  if (def === "linear" && !providers.linear) {
    diagnostics.push({
      level: "error",
      message:
        'tracker.default is "linear" but tracker.providers.linear is missing. ' +
        "Add a `team_key` under that block.",
    });
  }
  if (def === "github_issues" && !providers.github_issues.enabled) {
    diagnostics.push({
      level: "error",
      message:
        'tracker.default is "github_issues" but tracker.providers.github_issues.enabled is false.',
    });
  }
  if (def === "relay_native" && !providers.relay_native.enabled) {
    diagnostics.push({
      level: "error",
      message: "relay_native is the default but disabled — that combination resolves to nothing.",
    });
  }

  // Warn on the custom-field epic model (50-option cap per design doc).
  if (providers.github_projects?.epic_model === "custom_field") {
    diagnostics.push({
      level: "warn",
      message:
        'tracker.providers.github_projects.epic_model is "custom_field". GitHub caps single-select ' +
        "options at ~50; channels accumulating over a year will hit the wall. Consider " +
        '"parent_draft_item" (the default).',
    });
  }

  // Warn when use_draft_items is false — outbound-issue projection clutters the bug tracker.
  if (providers.github_projects?.use_draft_items === false) {
    diagnostics.push({
      level: "warn",
      message:
        "tracker.providers.github_projects.use_draft_items is false. Real-Issue projection " +
        "clutters the bug tracker and breaks the Relay-authoritative drift contract. Prefer the default.",
    });
  }

  // No diagnostic = ok.
  if (diagnostics.length === 0) {
    diagnostics.push({ level: "ok", message: `tracker.default = ${def}` });
  }
  return diagnostics;
}
