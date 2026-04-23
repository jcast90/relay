import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderProfileStore } from "../../src/storage/provider-profile-store.js";

describe("ProviderProfileStore", () => {
  let root: string;
  let store: ProviderProfileStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-provider-profiles-"));
    store = new ProviderProfileStore({ rootDir: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty list when the file does not exist yet", async () => {
    const list = await store.listProfiles();
    expect(list).toEqual([]);
    expect(await store.getDefaultProfileId()).toBeNull();
  });

  it("round-trips a profile via upsert / getProfile / listProfiles", async () => {
    const profile = await store.upsertProfile({
      id: "minimax",
      displayName: "MiniMax (M2)",
      adapter: "codex",
      envOverrides: { OPENAI_BASE_URL: "https://api.minimax.io/v1" },
      apiKeyEnvRef: "MINIMAX_API_KEY",
      defaultModel: "MiniMax-M2",
    });

    expect(profile.createdAt).toBeTruthy();
    expect(profile.updatedAt).toBeTruthy();

    const loaded = await store.getProfile("minimax");
    expect(loaded?.displayName).toBe("MiniMax (M2)");

    const list = await store.listProfiles();
    expect(list.map((p) => p.id)).toEqual(["minimax"]);
  });

  it("upsert replaces by id and preserves createdAt", async () => {
    const first = await store.upsertProfile({
      id: "minimax",
      displayName: "MiniMax",
      adapter: "codex",
      envOverrides: {},
    });

    // Force a different timestamp on the second write.
    await new Promise((r) => setTimeout(r, 2));

    const second = await store.upsertProfile({
      id: "minimax",
      displayName: "MiniMax Pro",
      adapter: "codex",
      envOverrides: { OPENAI_BASE_URL: "https://example.test/v1" },
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);

    const list = await store.listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe("MiniMax Pro");
    expect(list[0].envOverrides).toEqual({ OPENAI_BASE_URL: "https://example.test/v1" });
  });

  it("removeProfile returns false for an unknown id", async () => {
    expect(await store.removeProfile("nope")).toBe(false);
  });

  it("rejects secret-looking values in envOverrides at upsert", async () => {
    await expect(
      store.upsertProfile({
        id: "leaky",
        displayName: "Leaky",
        adapter: "codex",
        envOverrides: {
          OPENAI_BASE_URL: "https://api.minimax.io/v1",
          OPENAI_API_KEY: "sk-abcdef1234567890",
        },
      })
    ).rejects.toThrow(/OPENAI_API_KEY/);

    // Nothing should have been persisted.
    const list = await store.listProfiles();
    expect(list).toEqual([]);
  });

  it("round-trips the default profile id", async () => {
    await store.upsertProfile({
      id: "minimax",
      displayName: "MiniMax",
      adapter: "codex",
      envOverrides: {},
    });
    await store.setDefaultProfileId("minimax");
    expect(await store.getDefaultProfileId()).toBe("minimax");

    await store.setDefaultProfileId(null);
    expect(await store.getDefaultProfileId()).toBeNull();
  });

  it("refuses to set a default pointing at a missing profile", async () => {
    await expect(store.setDefaultProfileId("ghost")).rejects.toThrow(/does not exist/);
  });

  it("clears the default when the target profile is removed", async () => {
    await store.upsertProfile({
      id: "minimax",
      displayName: "MiniMax",
      adapter: "codex",
      envOverrides: {},
    });
    await store.setDefaultProfileId("minimax");
    expect(await store.getDefaultProfileId()).toBe("minimax");

    expect(await store.removeProfile("minimax")).toBe(true);
    expect(await store.getDefaultProfileId()).toBeNull();
  });

  it("tolerates a corrupt entry in an otherwise-valid file", async () => {
    const path = join(root, "provider-profiles.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          defaultProfileId: null,
          profiles: [
            { id: "broken" },
            {
              id: "ok",
              displayName: "OK",
              adapter: "codex",
              envOverrides: {},
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2
      )
    );

    const list = await store.listProfiles();
    expect(list.map((p) => p.id)).toEqual(["ok"]);
  });

  it("writes via a tmp-file + rename pattern (no leftover tmp files)", async () => {
    await store.upsertProfile({
      id: "a",
      displayName: "A",
      adapter: "claude",
      envOverrides: {},
    });

    const contents = await readFile(join(root, "provider-profiles.json"), "utf8");
    expect(() => JSON.parse(contents)).not.toThrow();

    // No stray tmp files should remain after a successful write.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root);
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
  });
});
