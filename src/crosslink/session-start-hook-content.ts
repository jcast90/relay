/**
 * Phase 4 Plan 02: Pure formatter for the SessionStart hook's stdout.
 *
 * Single-purpose: take a resolved channel name + per-repo state rows
 * (already derived via {@link deriveRepoAdminState} upstream — this module
 * does NOT re-derive) and return the printable text block that the hook
 * injects into the agent's first turn.
 *
 * Pure: NO `fs.*` imports, NO `Date.now()` reads. `nowMs` is an input so
 * tests are deterministic, and the formatter can be unit-tested without
 * any disk fixture. The generated `.mjs` hook script in
 * `src/crosslink/hook.ts::buildSessionStartNodeScript` inlines a string
 * mirror of this logic; the two MUST stay byte-equivalent. A behavioral-
 * equivalence test in `test/crosslink/session-start-hook.test.ts` enforces
 * this against the 4-state truth-table fixture.
 *
 * Output shape (per 04-CONTEXT.md D-03):
 *
 *     [Relay] Channel: oauth-rollout (3 repos)
 *       ● ui-repo        ready (admin: atlas-7f2)
 *       ● backend-repo   ready (admin: atlas-3a1)
 *       ○ sdk-repo       booting (since 2m ago)
 *     Feed: 4 new entries since you were last here. Use `rly status` for detail.
 *
 * Phrasing is intentionally factual / declarative — never imperative
 * (`MUST`, `ATTENTION`, `do not`). The hook writes into the agent's first
 * turn; imperatives there are a known prompt-injection anti-pattern
 * (04-RESEARCH.md). Test 7 in `session-start-hook-content.test.ts`
 * asserts the output never matches `/\b(MUST|ATTENTION)\b/`.
 */

import type { RepoAdminState } from "../domain/repo-admin-state.js";

/**
 * Per-repo row passed into {@link formatSessionStartContext}. The caller
 * (the hook's `.mjs` script body, or future TUI/GUI callers) has already
 * resolved `state` via the canonical derivation function. `adminAlias` is
 * surfaced only for `ready` rows; `bootingSinceMs` only for `booting`.
 */
export interface RepoState {
  alias: string;
  state: RepoAdminState;
  adminAlias?: string;
  bootingSinceMs?: number;
}

/**
 * Width to pad the repo alias column to so the state word lines up across
 * rows. 14 chars is the upper-bound observed for typical repo aliases
 * (ui-repo, backend-repo, sdk-repo, payments-service, etc.); longer
 * aliases push the state column right but the format still parses.
 */
const ALIAS_PAD = 14;

/**
 * Glyph column mapping (D-07 muted-ready / emphasized-exceptions rule).
 *
 *   - ready        → `●`  filled circle (calm baseline; per-surface color may dim it)
 *   - booting      → `○`  hollow circle (yellow per D-07 in TUI/GUI surfaces)
 *   - stale        → `×`  cross (red per D-07; pid dead or heartbeat aged)
 *   - disconnected → `·`  middle dot (dimmed per D-07; no session at all)
 *
 * Plain-text hook output uses these glyphs without ANSI color — Claude's
 * SessionStart context is consumed as plain UTF-8 by the model, and Codex
 * sometimes strips ANSI on the way in. The state word that follows the
 * glyph (`ready` / `booting` / `stale` / `disconnected`) is the canonical
 * machine-readable token; the glyph is presentational.
 */
export function glyphFor(state: RepoAdminState): string {
  switch (state) {
    case "ready":
      return "●";
    case "booting":
      return "○";
    case "stale":
      return "×";
    case "disconnected":
      return "·";
  }
}

/**
 * Inline relative-time helper. Avoids a date-fns dependency in the
 * generated `.mjs` script (which must be self-contained — no `import` of
 * a third-party module). Same three buckets the inlined `.mjs` mirror
 * uses: < 60s → `Ns`, < 60m → `Nm`, else `Nh`. Floors to whole units;
 * 130_000 ms → `2m` (not `2.16m`).
 */
function formatRelative(ms: number): string {
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * Parenthesized detail tail per state (D-03):
 *
 *   - ready      → `(admin: <adminAlias>)` when present, else `""`.
 *   - booting    → `(since <Nm ago>)` from `bootingSinceMs`. Empty when
 *                  the caller didn't supply it.
 *   - stale      → `(stale)` — yes, repeats the state word; the parens
 *                  draw the eye to the exception per D-07.
 *   - disconnected → `""`.
 */
export function detailFor(repo: RepoState, _nowMs: number): string {
  switch (repo.state) {
    case "ready":
      return repo.adminAlias ? ` (admin: ${repo.adminAlias})` : "";
    case "booting":
      if (typeof repo.bootingSinceMs !== "number") return "";
      return ` (since ${formatRelative(repo.bootingSinceMs)} ago)`;
    case "stale":
      return " (stale)";
    case "disconnected":
      return "";
  }
}

/**
 * Build the printable hook output.
 *
 * Empty contract: `repoStates.length === 0` → `""`. Lets callers
 * append-then-skip-on-empty without a separate length check (same shape
 * as `formatActiveSessionsBlock` in `src/cli/print-status-context.ts`).
 *
 * Feed tail gating (per Plan 02 must_haves):
 *   - `newFeedEntries === undefined` → omit (caller has no watermark to
 *     subtract against; usually `RELAY_SESSION_ID` was unset).
 *   - `newFeedEntries === 0` → omit (nothing new to surface).
 *   - `newFeedEntries > 0` → append the `Feed: N new entries…` line.
 *
 * `nowMs` is accepted for future-proofing relative-time formatting that
 * may need the wall clock; today the only relative time is
 * `bootingSinceMs`, which is already a delta. Passing `nowMs` keeps the
 * signature stable when a future surface (e.g. `(seen 30s ago)` for stale
 * rows) wants absolute-now math.
 */
export function formatSessionStartContext(input: {
  channelName: string;
  repoStates: RepoState[];
  newFeedEntries?: number;
  nowMs?: number;
}): string {
  if (input.repoStates.length === 0) return "";

  const nowMs = input.nowMs ?? 0;
  const lines: string[] = [];
  lines.push(`[Relay] Channel: ${input.channelName} (${input.repoStates.length} repos)`);

  for (const repo of input.repoStates) {
    const glyph = glyphFor(repo.state);
    const alias = repo.alias.padEnd(ALIAS_PAD);
    const detail = detailFor(repo, nowMs);
    lines.push(`  ${glyph} ${alias} ${repo.state}${detail}`);
  }

  if (typeof input.newFeedEntries === "number" && input.newFeedEntries > 0) {
    lines.push(
      `Feed: ${input.newFeedEntries} new entries since you were last here. Use \`rly status\` for detail.`
    );
  }

  return lines.join("\n");
}
