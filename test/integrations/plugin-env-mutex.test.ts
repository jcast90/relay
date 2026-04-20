import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withEnvOverride } from "../../src/integrations/plugin-env-mutex.js";

const KEY = "PLUGIN_ENV_MUTEX_TEST_VAR";
const OTHER_KEY = "PLUGIN_ENV_MUTEX_TEST_VAR_B";

function snapshotAndClear(): { key: string | undefined; other: string | undefined } {
  const snap = { key: process.env[KEY], other: process.env[OTHER_KEY] };
  delete process.env[KEY];
  delete process.env[OTHER_KEY];
  return snap;
}

function restore(snap: { key: string | undefined; other: string | undefined }): void {
  if (snap.key === undefined) delete process.env[KEY];
  else process.env[KEY] = snap.key;
  if (snap.other === undefined) delete process.env[OTHER_KEY];
  else process.env[OTHER_KEY] = snap.other;
}

describe("withEnvOverride — trivial overlay and restore", () => {
  let snap: { key: string | undefined; other: string | undefined };

  beforeEach(() => {
    snap = snapshotAndClear();
  });

  afterEach(() => {
    restore(snap);
  });

  it("sets the env var for the duration of fn and restores after", async () => {
    expect(process.env[KEY]).toBeUndefined();
    const inner = await withEnvOverride({ [KEY]: "A" }, () => process.env[KEY]);
    expect(inner).toBe("A");
    expect(process.env[KEY]).toBeUndefined();
  });

  it("restores prior value when the key was already set", async () => {
    process.env[KEY] = "PRIOR";
    const inner = await withEnvOverride({ [KEY]: "OVERLAY" }, () => process.env[KEY]);
    expect(inner).toBe("OVERLAY");
    expect(process.env[KEY]).toBe("PRIOR");
  });

  it("returns the value produced by fn (including async fns)", async () => {
    const value = await withEnvOverride({ [KEY]: "X" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return `${process.env[KEY]}!`;
    });
    expect(value).toBe("X!");
    expect(process.env[KEY]).toBeUndefined();
  });
});

describe("withEnvOverride — serialization of concurrent overlays", () => {
  let snap: { key: string | undefined; other: string | undefined };

  beforeEach(() => {
    snap = snapshotAndClear();
  });

  afterEach(() => {
    restore(snap);
  });

  it("never lets concurrent callers observe each other's overlays even with internal awaits", async () => {
    // Both callers look at process.env[KEY] before and after an await.
    // If the mutex is correct, each caller sees only its own value at both
    // observation points.
    const observations: Array<{ who: "A" | "B"; before: string | undefined; after: string | undefined }> = [];

    const callA = withEnvOverride({ [KEY]: "AAA" }, async () => {
      const before = process.env[KEY];
      await new Promise((r) => setTimeout(r, 20));
      const after = process.env[KEY];
      observations.push({ who: "A", before, after });
    });

    const callB = withEnvOverride({ [KEY]: "BBB" }, async () => {
      const before = process.env[KEY];
      await new Promise((r) => setTimeout(r, 20));
      const after = process.env[KEY];
      observations.push({ who: "B", before, after });
    });

    await Promise.all([callA, callB]);

    expect(observations).toHaveLength(2);
    for (const obs of observations) {
      const expected = obs.who === "A" ? "AAA" : "BBB";
      expect(obs.before).toBe(expected);
      expect(obs.after).toBe(expected);
    }

    expect(process.env[KEY]).toBeUndefined();
  });

  it("runs overlays strictly in queued order", async () => {
    const order: string[] = [];
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 5; i++) {
      const label = `job-${i}`;
      jobs.push(
        withEnvOverride({ [KEY]: label }, async () => {
          order.push(`start:${label}:${process.env[KEY]}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end:${label}:${process.env[KEY]}`);
        }),
      );
    }
    await Promise.all(jobs);

    // Each job's start and end must appear consecutively (no interleaving),
    // and each must see its own label in env[KEY].
    for (let i = 0; i < 5; i++) {
      expect(order[i * 2]).toBe(`start:job-${i}:job-${i}`);
      expect(order[i * 2 + 1]).toBe(`end:job-${i}:job-${i}`);
    }
  });
});

describe("withEnvOverride — restore on throw", () => {
  let snap: { key: string | undefined; other: string | undefined };

  beforeEach(() => {
    snap = snapshotAndClear();
  });

  afterEach(() => {
    restore(snap);
  });

  it("restores env even when fn throws synchronously", async () => {
    process.env[KEY] = "PRIOR";
    await expect(
      withEnvOverride({ [KEY]: "OVERLAY" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env[KEY]).toBe("PRIOR");
  });

  it("restores env even when fn rejects asynchronously", async () => {
    process.env[KEY] = "PRIOR";
    await expect(
      withEnvOverride({ [KEY]: "OVERLAY" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
    expect(process.env[KEY]).toBe("PRIOR");
  });

  it("does not poison the chain: later callers still run after a rejection", async () => {
    const rejected = withEnvOverride({ [KEY]: "BAD" }, () => {
      throw new Error("nope");
    });
    await expect(rejected).rejects.toThrow("nope");

    const value = await withEnvOverride({ [KEY]: "OK" }, () => process.env[KEY]);
    expect(value).toBe("OK");
  });
});

describe("withEnvOverride — recursion self-deadlock guard", () => {
  let snap: { key: string | undefined; other: string | undefined };

  beforeEach(() => {
    snap = snapshotAndClear();
  });

  afterEach(() => {
    restore(snap);
  });

  it("throws when fn reenters withEnvOverride directly (would otherwise deadlock)", async () => {
    const recursive = withEnvOverride({ [KEY]: "OUTER" }, async () => {
      // This inner call would block forever on the outer's chain promise if
      // the guard were absent. The guard must throw synchronously-from-the-
      // perspective-of-the-inner-promise so the outer fn surfaces the error.
      await withEnvOverride({ [KEY]: "INNER" }, () => process.env[KEY]);
    });

    await expect(recursive).rejects.toThrow(
      /recursive call detected/,
    );
    // Outer's finally must have run, restoring env.
    expect(process.env[KEY]).toBeUndefined();
  });

  it("keeps the chain usable: a normal call after a recursion-error still resolves", async () => {
    const bad = withEnvOverride({ [KEY]: "OUTER" }, async () => {
      await withEnvOverride({ [KEY]: "INNER" }, () => undefined);
    });
    await expect(bad).rejects.toThrow(/recursive call detected/);

    const value = await withEnvOverride({ [KEY]: "OK" }, () => process.env[KEY]);
    expect(value).toBe("OK");
    expect(process.env[KEY]).toBeUndefined();
  });
});

describe("withEnvOverride — unset semantics", () => {
  let snap: { key: string | undefined; other: string | undefined };

  beforeEach(() => {
    snap = snapshotAndClear();
  });

  afterEach(() => {
    restore(snap);
  });

  it("deletes process.env[KEY] when override value is undefined, and restores prior value", async () => {
    process.env[KEY] = "PRIOR";
    const inner = await withEnvOverride({ [KEY]: undefined }, () => process.env[KEY]);
    expect(inner).toBeUndefined();
    expect(process.env[KEY]).toBe("PRIOR");
  });

  it("handles the unset case when the key had no prior value", async () => {
    expect(process.env[KEY]).toBeUndefined();
    const inner = await withEnvOverride({ [KEY]: undefined }, () => process.env[KEY]);
    expect(inner).toBeUndefined();
    expect(process.env[KEY]).toBeUndefined();
  });

  it("supports multiple keys in the same call", async () => {
    process.env[KEY] = "prior-A";
    process.env[OTHER_KEY] = "prior-B";
    const [a, b] = await withEnvOverride({ [KEY]: "new-A", [OTHER_KEY]: undefined }, () => [
      process.env[KEY],
      process.env[OTHER_KEY],
    ]);
    expect(a).toBe("new-A");
    expect(b).toBeUndefined();
    expect(process.env[KEY]).toBe("prior-A");
    expect(process.env[OTHER_KEY]).toBe("prior-B");
  });
});
