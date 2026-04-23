import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getGlobalRoot } from "../cli/workspace-registry.js";
import {
  type ProviderProfile,
  ProviderProfileSchema,
  validateEnvOverrides,
} from "../domain/provider-profile.js";

const PROFILES_FILENAME = "provider-profiles.json";

interface ProviderProfilesDoc {
  defaultProfileId: string | null;
  profiles: ProviderProfile[];
}

let tmpCounter = 0;

function emptyDoc(): ProviderProfilesDoc {
  return { defaultProfileId: null, profiles: [] };
}

export interface ProviderProfileStoreOptions {
  /** Root directory. Defaults to `getGlobalRoot()` (i.e. `~/.relay`). Tests override. */
  rootDir?: string;
}

export class ProviderProfileStore {
  private readonly rootDir: string;

  constructor(options: ProviderProfileStoreOptions = {}) {
    this.rootDir = options.rootDir ?? getGlobalRoot();
  }

  getPath(): string {
    return join(this.rootDir, PROFILES_FILENAME);
  }

  private async readDoc(): Promise<ProviderProfilesDoc> {
    const path = this.getPath();
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyDoc();
      }
      throw new Error(
        `Failed to read provider-profiles at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Corrupt provider-profiles at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    const doc = (raw ?? {}) as Partial<ProviderProfilesDoc>;
    const profiles = Array.isArray(doc.profiles)
      ? doc.profiles
          .map((p) => ProviderProfileSchema.safeParse(p))
          .filter((r): r is { success: true; data: ProviderProfile } => r.success)
          .map((r) => r.data)
      : [];
    return {
      defaultProfileId: typeof doc.defaultProfileId === "string" ? doc.defaultProfileId : null,
      profiles,
    };
  }

  private async writeDoc(doc: ProviderProfilesDoc): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const path = this.getPath();
    const tmpPath = `${path}.tmp.${process.pid}.${tmpCounter++}`;
    await writeFile(tmpPath, JSON.stringify(doc, null, 2));
    try {
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw new Error(
        `Failed to commit provider-profiles at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err }
      );
    }
  }

  async listProfiles(): Promise<ProviderProfile[]> {
    const doc = await this.readDoc();
    return [...doc.profiles].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProfile(id: string): Promise<ProviderProfile | null> {
    const doc = await this.readDoc();
    return doc.profiles.find((p) => p.id === id) ?? null;
  }

  async upsertProfile(
    profile: Omit<ProviderProfile, "createdAt" | "updatedAt"> &
      Partial<Pick<ProviderProfile, "createdAt" | "updatedAt">>
  ): Promise<ProviderProfile> {
    const envCheck = validateEnvOverrides(profile.envOverrides);
    if (!envCheck.ok) {
      throw new Error(`Refusing to persist envOverrides[${envCheck.key}]: ${envCheck.reason}`);
    }

    const doc = await this.readDoc();
    const now = new Date().toISOString();
    const existing = doc.profiles.find((p) => p.id === profile.id);

    const merged: ProviderProfile = ProviderProfileSchema.parse({
      ...profile,
      envOverrides: profile.envOverrides ?? {},
      createdAt: existing?.createdAt ?? profile.createdAt ?? now,
      updatedAt: now,
    });

    const next = doc.profiles.filter((p) => p.id !== merged.id);
    next.push(merged);
    await this.writeDoc({ ...doc, profiles: next });
    return merged;
  }

  async removeProfile(id: string): Promise<boolean> {
    const doc = await this.readDoc();
    const before = doc.profiles.length;
    const profiles = doc.profiles.filter((p) => p.id !== id);
    if (profiles.length === before) return false;
    const defaultProfileId = doc.defaultProfileId === id ? null : doc.defaultProfileId;
    await this.writeDoc({ defaultProfileId, profiles });
    return true;
  }

  async getDefaultProfileId(): Promise<string | null> {
    const doc = await this.readDoc();
    if (!doc.defaultProfileId) return null;
    // If the referenced profile is gone, report null rather than a dangling id.
    const exists = doc.profiles.some((p) => p.id === doc.defaultProfileId);
    return exists ? doc.defaultProfileId : null;
  }

  async setDefaultProfileId(id: string | null): Promise<void> {
    const doc = await this.readDoc();
    if (id !== null && !doc.profiles.some((p) => p.id === id)) {
      throw new Error(`Cannot set default: profile '${id}' does not exist`);
    }
    await this.writeDoc({ ...doc, defaultProfileId: id });
  }
}
