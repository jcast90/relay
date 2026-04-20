/**
 * Tiny serialization primitive for AO plugin factories that read credentials
 * from `process.env` at construction time.
 *
 * The AO plugin packages (`@aoagents/ao-plugin-tracker-github`,
 * `-tracker-linear`, `-scm-github`) expose zero-arg `create()` factories that
 * snapshot env vars like `GITHUB_TOKEN` / `LINEAR_API_KEY` / `COMPOSIO_API_KEY`
 * immediately. To honor per-caller tokens we must temporarily overlay those
 * env vars, run the factory, then restore. If two such overlays race, they
 * can observe each other's values.
 *
 * `withEnvOverride` serializes every call behind a shared module-local
 * promise chain so at most one `fn` ever executes inside an overlay at a
 * time, across all callers in the process.
 */

// Shared chain: every call appends its work here, and the next caller waits
// on the returned promise. We never surface rejections from `fn` onto the
// chain — always settle with `undefined` so a single failure does not poison
// subsequent callers.
let chain: Promise<void> = Promise.resolve();

export async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prior = chain;
  let release!: () => void;
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prior;

  const savedKeys = Object.keys(overrides);
  const saved: Record<string, string | undefined> = {};
  for (const key of savedKeys) saved[key] = process.env[key];

  try {
    for (const key of savedKeys) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of savedKeys) {
      const previous = saved[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    release();
  }
}
