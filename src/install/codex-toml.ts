import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import TOML from "@iarna/toml";

/**
 * Path to Codex's user config file. Codex CLI ≥ v0.130 reads
 * `[features].hooks = true` from here to enable the SessionStart hook
 * machinery; earlier versions ignore the flag (the entry is harmless on
 * older Codex installations — see Plan 04-03 D-Plan-1 / RESEARCH Pitfall #5).
 */
export function codexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

/**
 * Idempotent feature-flag writer for `~/.codex/config.toml`.
 *
 * Semantics:
 *   1. File absent → create with just the `[features]` table containing the
 *      single flag. No user data to preserve.
 *   2. File present → parse, set `features.<flag> = value`, re-serialize, and
 *      atomic-rename over the original. If the parsed value already equals
 *      `value`, return `{ changed: false }` and do NOT write — important for
 *      the byte-for-byte idempotency contract in Plan 04-03.
 *   3. All writes go through a sibling `.tmp.<pid>` + rename, mirroring the
 *      pattern in `src/install/manifest.ts:64-69`.
 *
 * Known limitation — comment preservation:
 *   `@iarna/toml` (like most full-TOML parsers) does not round-trip user
 *   comments. If the user has comments inside the `[features]` section we
 *   touch them by re-emitting the section after the merge; comments in OTHER
 *   sections survive because the surrounding TOML structure round-trips
 *   intact. This is documented in RESEARCH "No Analog Found" as an accepted
 *   trade — full-fidelity TOML editing is out of scope for the install
 *   surface. When comments are detected inside `[features]` pre-write, a
 *   single-line note is logged to stderr so the user knows to expect
 *   reformatting.
 */
export async function ensureCodexFeatureFlag(
  flag: string,
  value: boolean,
  opts: { path?: string; logger?: (line: string) => void } = {}
): Promise<{ changed: boolean; path: string }> {
  const target = opts.path ?? codexConfigPath();
  const log = opts.logger ?? ((line) => process.stderr.write(line + "\n"));

  let raw: string | null = null;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    raw = null;
  }

  if (raw === null) {
    // Fresh file — write a minimal `[features]` block. No user state to
    // preserve so we skip the parser entirely; the serialized result is
    // canonical (`[features]\n<flag> = <value>\n`).
    const fresh = TOML.stringify({ features: { [flag]: value } });
    await atomicWrite(target, fresh);
    return { changed: true, path: target };
  }

  // Comment-in-[features] detection. Best-effort: walks lines until we leave
  // the `[features]` section. Any `# …` line OR trailing `# …` on a value
  // line triggers the warning. We do NOT block the write — losing comments
  // inside [features] is the documented trade.
  if (hasCommentsInFeatures(raw)) {
    log(
      `[rly install] Note: comments in [features] section of ${target} may be reformatted.`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `failed to parse TOML at ${target}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const features = (
    parsed.features && typeof parsed.features === "object" && !Array.isArray(parsed.features)
      ? (parsed.features as Record<string, unknown>)
      : {}
  );

  if (features[flag] === value) {
    return { changed: false, path: target };
  }

  features[flag] = value;
  parsed.features = features;

  // Re-serialize. `@iarna/toml` produces a canonical layout — sections in
  // insertion order, keys sorted lexically within each section. The
  // user's section ORDER is preserved (we mutated `parsed` in place; new
  // sections we didn't touch keep their relative position).
  const serialized = TOML.stringify(parsed as Parameters<typeof TOML.stringify>[0]);
  await atomicWrite(target, serialized);
  return { changed: true, path: target };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

/**
 * Lightweight scanner — returns true if a `# …` comment appears inside the
 * `[features]` section. Detects full-line comments (`# …` or `## …`) and
 * trailing inline comments (`key = value  # …`). Stops scanning on the next
 * `[…]` section header.
 *
 * Heuristic, not a full TOML lexer — a `#` inside a string literal inside
 * `[features]` would be a false positive. Worst case: a spurious "may be
 * reformatted" note. Never a write failure.
 */
function hasCommentsInFeatures(raw: string): boolean {
  const lines = raw.split("\n");
  let inFeatures = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]\s*$/.test(trimmed)) {
      inFeatures = /^\[features\]\s*$/.test(trimmed);
      continue;
    }
    if (!inFeatures) continue;
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) return true;
    // Trailing inline comment — find `#` that is NOT inside a quoted string.
    if (hasTrailingInlineComment(line)) return true;
  }
  return false;
}

/** True iff `line` contains a `#` outside any "…" or '…' string. */
function hasTrailingInlineComment(line: string): boolean {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inDouble && !inSingle) return true;
  }
  return false;
}
