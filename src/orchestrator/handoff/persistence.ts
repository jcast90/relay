/**
 * Handoff brief persistence layer (Phase 2 PR-2 / Wave 2).
 *
 * Owns disk I/O for `~/.relay/channels/<channelId>/handoffs/<briefId>.{md,gap.json}`
 * — the first versioned `~/.relay/` artifact (D-05). All writes are atomic
 * (tmp-file + `rename`), mirroring `ChannelStore.writeChannel` /
 * `writeTrackedPrs`. All reads fail closed on `schemaVersion !== 1` (M9).
 *
 * Path-traversal is guarded twice: `assertSafeSegment` runs on `channelId`
 * AND on `briefId`, and `assertValidBriefId` enforces the
 * `brief-<unix-ms>-<base36>` shape on top of that (T-02-01, T-02-10).
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "../../cli/paths.js";
import { assertSafeSegment } from "../../storage/file-store.js";
import { HANDOFF_BRIEF_SCHEMA_VERSION, type GapFillBlock } from "../../domain/handoff.js";
import { buildBriefId } from "./synthesizer.js";

/** Shared regex — id format is part of the on-disk contract (D-05 / T-02-10). */
const BRIEF_ID_REGEX = /^brief-[0-9]+-[a-z0-9]+$/;

/** Default staleness window for `readLatestGapFill` — RESEARCH Pitfall 3. */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Per-process counter that, combined with `pid` + `Date.now()`, makes the
 * tmp-file name unique even when two writes land in the same millisecond
 * (mirrors `channel-store.ts`'s `channelTicketsTmpCounter`).
 */
let tmpCounter = 0;

/**
 * Validate a `briefId` matches the canonical
 * `brief-<unix-ms>-<6-char-base36>` shape. Throws on mismatch.
 *
 * The synthesizer mints ids via {@link buildBriefId}; the MCP tool reuses
 * the same helper. The regex check is defense-in-depth for any code path
 * that accepts an id from the outside world (e.g. `--resume <briefId>`).
 */
export function assertValidBriefId(briefId: string): void {
  if (!BRIEF_ID_REGEX.test(briefId)) {
    throw new Error(`Invalid briefId: ${briefId}. Expected shape: brief-<unix-ms>-<base36>.`);
  }
}

/** Resolve `~/.relay/channels/<channelId>/handoffs/`, creating it on demand. */
async function getHandoffsDir(channelId: string): Promise<string> {
  assertSafeSegment(channelId, "channelId");
  const dir = join(getRelayDir(), "channels", channelId, "handoffs");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Atomic write helper: tmp file + rename. */
async function atomicWrite(finalPath: string, content: string): Promise<void> {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${tmpCounter++}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, finalPath);
}

export interface WriteBriefArtifactInput {
  channelId: string;
  briefId: string;
  markdown: string;
  gapFill: GapFillBlock;
}

export interface WriteBriefArtifactResult {
  mdPath: string;
  gapJsonPath: string;
}

/**
 * Write both the rendered brief markdown AND the gap-fill JSON for a
 * single handoff. Used by the CLI (Wave 4) when a brief has been built and
 * needs to be persisted alongside its (possibly placeholder) gap-fill.
 *
 * Both files are written via tmp-rename so a reader never observes a
 * partial file.
 */
export async function writeBriefArtifact(
  input: WriteBriefArtifactInput
): Promise<WriteBriefArtifactResult> {
  assertSafeSegment(input.channelId, "channelId");
  assertValidBriefId(input.briefId);
  if (input.gapFill.schemaVersion !== HANDOFF_BRIEF_SCHEMA_VERSION) {
    throw new Error(
      `writeBriefArtifact rejected gapFill with schemaVersion ${input.gapFill.schemaVersion}; ` +
        `only ${HANDOFF_BRIEF_SCHEMA_VERSION} is supported.`
    );
  }

  const dir = await getHandoffsDir(input.channelId);
  const mdPath = join(dir, `${input.briefId}.md`);
  const gapJsonPath = join(dir, `${input.briefId}.gap.json`);

  await atomicWrite(mdPath, input.markdown);
  await atomicWrite(gapJsonPath, JSON.stringify(input.gapFill, null, 2));

  return { mdPath, gapJsonPath };
}

export interface WriteGapFillInput {
  channelId: string;
  briefId: string;
  payload: GapFillBlock;
}

export interface WriteGapFillResult {
  gapJsonPath: string;
}

/**
 * Write only the gap-fill JSON. The MCP tool's path: the brief markdown
 * is generated later by `buildBrief` when `rly handoff` runs.
 *
 * Two consecutive calls for the same channel produce two distinct
 * `<briefId>.gap.json` files — never overwrite. The synthesizer reads the
 * newest non-stale one via {@link readLatestGapFill}.
 */
export async function writeGapFill(input: WriteGapFillInput): Promise<WriteGapFillResult> {
  assertSafeSegment(input.channelId, "channelId");
  assertValidBriefId(input.briefId);
  if (input.payload.schemaVersion !== HANDOFF_BRIEF_SCHEMA_VERSION) {
    throw new Error(
      `writeGapFill rejected payload with schemaVersion ${input.payload.schemaVersion}; ` +
        `only ${HANDOFF_BRIEF_SCHEMA_VERSION} is supported.`
    );
  }

  const dir = await getHandoffsDir(input.channelId);
  const gapJsonPath = join(dir, `${input.briefId}.gap.json`);
  await atomicWrite(gapJsonPath, JSON.stringify(input.payload, null, 2));

  return { gapJsonPath };
}

export interface ReadLatestGapFillOptions {
  /** Defaults to 1 hour (RESEARCH Pitfall 3). */
  maxAgeMs?: number;
  /** Pure-over-declared-inputs — pass the clock in. */
  now: Date;
}

/**
 * List `~/.relay/channels/<id>/handoffs/*.gap.json`, parse each, drop any
 * record with `schemaVersion !== 1` (M9 — fail closed; future bumps
 * require coordinated upgrade), pick the newest by `capturedAt`, and
 * return `null` if it's older than `maxAgeMs`.
 *
 * Robustness: returns `null` (not throws) when the directory doesn't
 * exist, when no files match the pattern, or when a single file has a
 * JSON parse error (the bad file is skipped, not propagated).
 */
export async function readLatestGapFill(
  channelId: string,
  opts: ReadLatestGapFillOptions
): Promise<GapFillBlock | null> {
  assertSafeSegment(channelId, "channelId");
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const dir = join(getRelayDir(), "channels", channelId, "handoffs");

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }

  const gapPattern = /^brief-[0-9]+-[a-z0-9]+\.gap\.json$/;
  const candidates = entries.filter((name) => gapPattern.test(name));
  if (candidates.length === 0) return null;

  let newest: GapFillBlock | null = null;
  let newestMs = -Infinity;

  for (const name of candidates) {
    const filePath = join(dir, name);
    let parsed: unknown;
    try {
      const content = await readFile(filePath, "utf8");
      parsed = JSON.parse(content);
    } catch {
      // Skip unreadable / unparsable files — don't kill the whole read.
      continue;
    }

    if (!isGapFillBlock(parsed)) continue;
    // M9 — fail closed on schemaVersion drift. Future bumps require a
    // coordinated upgrade across writer + reader; until then, anything
    // that isn't `1` is treated as if absent.
    if (parsed.schemaVersion !== HANDOFF_BRIEF_SCHEMA_VERSION) continue;

    const ms = Date.parse(parsed.capturedAt);
    if (Number.isNaN(ms)) continue;
    if (ms > newestMs) {
      newestMs = ms;
      newest = parsed;
    }
  }

  if (!newest) return null;

  const ageMs = opts.now.getTime() - newestMs;
  if (ageMs > maxAgeMs) return null;

  return newest;
}

/** Structural type guard for `GapFillBlock`. Tolerant of unknown JSON. */
function isGapFillBlock(value: unknown): value is GapFillBlock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schemaVersion === "number" &&
    typeof v.briefId === "string" &&
    typeof v.channelId === "string" &&
    typeof v.capturedAt === "string" &&
    (v.capturedBySessionId === null || typeof v.capturedBySessionId === "string") &&
    typeof v.currentLineOfAttack === "string" &&
    typeof v.activeHypothesis === "string" &&
    Array.isArray(v.abandonedApproaches) &&
    Array.isArray(v.openQuestions)
  );
}

/** Re-exported for callers that mint ids alongside writes (e.g. the MCP tool). */
export { buildBriefId };
