/**
 * Provider-profile shape the dispatch path consumes. Structural subset of
 * the schema PR 1 defines in `src/domain/provider-profile.ts` — dispatch
 * only needs `adapter`, `defaultModel`, `envOverrides`, and
 * `apiKeyEnvRef`, so PR 1's extra fields (id / displayName /
 * createdAt / updatedAt) are elided for runtime-less import purposes.
 *
 * TODO(PR1): once PR 1 lands, delete this interface and re-export
 * `ProviderProfile` from `../domain/provider-profile.js`. The live types
 * are structurally compatible, so callers need no changes.
 */
export interface ProviderProfile {
  id: string;
  displayName: string;
  adapter: "claude" | "codex";
  envOverrides: Record<string, string>;
  apiKeyEnvRef?: string;
  defaultModel?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Narrow read-only view of the provider-profile store the dispatch path
 * needs. Typed as a shape (not imported from the store directly) so
 * orchestrator tests can run against an in-memory impl without on-disk
 * state, and so this PR stays decoupled from PR 1's
 * `ProviderProfileStore` landing.
 *
 * TODO(PR1): PR 1's `ProviderProfileStore` already satisfies this shape —
 * callers can pass `new ProviderProfileStore()` directly once the import
 * unblocks. Keep the indirection for test ergonomics; don't delete it.
 */
export interface ProviderProfileLookup {
  getProfile(id: string): Promise<ProviderProfile | null>;
  getDefaultProfileId(): Promise<string | null>;
}

/**
 * Null-implementation default: every query returns `null`. Used while
 * PR 1's `ProviderProfileStore` is still in flight so dispatch never has
 * to reference that module; swap it for the real store in a single line
 * once PR 1 merges (see `dispatch.ts` TODO(PR1) comment).
 */
export class NullProviderProfileLookup implements ProviderProfileLookup {
  async getProfile(_id: string): Promise<ProviderProfile | null> {
    return null;
  }

  async getDefaultProfileId(): Promise<string | null> {
    return null;
  }
}

/**
 * Deterministic in-memory implementation used by orchestrator tests.
 * Accepts a static profile map + optional default id. Returns
 * `Promise<null>` for unknown ids so callers exercise the missing-profile
 * branch exactly the same way the on-disk store does.
 */
export class InMemoryProviderProfileLookup implements ProviderProfileLookup {
  constructor(
    private readonly profiles: Map<string, ProviderProfile> = new Map(),
    private readonly defaultProfileId: string | null = null
  ) {}

  async getProfile(id: string): Promise<ProviderProfile | null> {
    return this.profiles.get(id) ?? null;
  }

  async getDefaultProfileId(): Promise<string | null> {
    return this.defaultProfileId;
  }
}
