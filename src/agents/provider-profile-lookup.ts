import type { ProviderProfile } from "../domain/provider-profile.js";

export type { ProviderProfile };

/**
 * Narrow read-only view of the provider-profile store the dispatch path
 * needs. Kept as a shape (not a direct store import) so orchestrator tests
 * can run against {@link InMemoryProviderProfileLookup} without touching
 * `~/.relay/provider-profiles.json`. `ProviderProfileStore` from
 * `src/storage/provider-profile-store.ts` satisfies this interface
 * structurally.
 */
export interface ProviderProfileLookup {
  getProfile(id: string): Promise<ProviderProfile | null>;
  getDefaultProfileId(): Promise<string | null>;
}

/**
 * Deterministic in-memory implementation used by orchestrator tests.
 * Returns `Promise<null>` for unknown ids so callers exercise the
 * missing-profile branch exactly the same way the on-disk store does.
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
