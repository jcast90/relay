# Phase 2 — Plan Check

**Verified:** 2026-05-09
**Plan:** `.planning/phases/02-handoff-command-brief-synthesizer/02-PLAN.md`
**Phase goal (ROADMAP.md L34-52):** `rly handoff <channelId> --to <value>` produces a structured brief from `~/.relay/` artifacts, lets the departing agent fill working-memory gaps via `channel_handoff_finalize` MCP tool, and seeds a fresh session in the destination provider with the brief — instead of replaying raw transcript. The 90% nudge subscribes to Phase 1's threshold event and surfaces via the AL-7 approval queue.

---

## VERDICT: NEEDS_REVISION

The plan is genuinely thoughtful, the locked decisions (D-01…D-09) trace back cleanly to the design notes, the threat model is comprehensive, and the wave/PR structure is well-disciplined. Goal-backward verification surfaces **two HIGH-severity findings that will defeat execution as written**, plus a cluster of MEDIUM findings that are mostly 1-3-line fixes.

Most consequential gap: **the plan's threshold-listener references an `ApprovalsQueue.list({ kind, sessionId })` API shape that does not exist in `src/approvals/queue.ts`**. The actual signature is `list(sessionId: string, options: ListOptions = {})` where `ListOptions` only supports `{ status? }` — no `kind` filter, and `sessionId` is positional not keyed. This breaks the listener's restart-idempotency seed (Step 2 of Task 3.1) and is referenced again in the post-merge audit. The implementer will hit this immediately.

Second consequential gap: **Phase 2 is being verified while Phase 1 is in revision iteration 2**, and Phase 1's CHECK flagged the SUMMARY filename (L5) and the handoff-id contract test (M5) as items that affect Phase 2 directly. Phase 2's PLAN copies the same non-standard SUMMARY filename pattern and inherits the un-tested handoff-id contract.

---

## HIGH-SEVERITY FINDINGS (must fix before execution)

### H1. Threshold listener references an `ApprovalsQueue.list` API shape that does not exist

**Affects:** Task 3.1 Step 2 ("Init `seen` by reading `approvalsQueue.list({ kind: \"handoff-prompt\", sessionId })` at attach time"); `<verification>` step 5.
**Severity:** HIGH (blocker — TS compile error on first attempt).

**Gap.** The plan invokes the queue's list method with an object argument, but the actual signature in `src/approvals/queue.ts:312` is:

```ts
async list(sessionId: string, options: ListOptions = {}): Promise<ApprovalRecord[]>
// ListOptions = { status?: ApprovalStatus }  — no `kind` filter
```

Three problems compound:
1. `sessionId` is positional, not a key in an options bag.
2. There is no `kind` filter on `ListOptions`. Multiple kinds coexist per session; caller must filter in JS after `list()`.
3. The records carry `entryId` semantics inside `payload`, but `HandoffPromptPayload` (in `<interfaces>`) has no `entryId` field — the dedup mechanism is half-defined.

**Suggested fix.**
1. Replace the list call in Task 3.1 Step 2 with the actual API:
   ```ts
   const existing = await approvalsQueue.list(sessionId);
   for (const rec of existing) {
     if (rec.kind !== "handoff-prompt") continue;
     // dedup on (sessionId, threshold) — D-03's contract — extracted from rec.payload.thresholdPct
   }
   ```
2. Pick a single dedup key — drop the `entryId` half. D-03 already says dedup by `(sessionId, threshold)`. The in-memory `Set<entryId>` is fine for same-process polling; the **restart-idempotency seed must dedup by `(sessionId, threshold)`** extracted from `payload.thresholdPct`. Make explicit in Step 2.
3. Optionally add `entryId?: string` to `HandoffPromptPayload` if you want post-restart dedup keyed on the source feed entry; otherwise accept restart loses entryId set and falls back to threshold-pct dedup.

Also: `<verification>` step 5 grep includes `src/approvals/queue.ts` (a pre-existing file) — adds noise. Tighten to Phase-2-authored paths only: `src/orchestrator/handoff/`, `src/cli/handoff.ts`, plus the diffs added to `src/mcp/channel-tools.ts`, `src/orchestrator/dispatch.ts`, `src/cli/run-autonomous.ts`. A stray `from "../budget/..."` introduced by Wave 3's dispatch wiring would be missed by current scope.

---

### H2. Phase 1 dependency: SUMMARY filename + handoff-id test gap inherited

**Affects:** `<output>` block referencing `02-handoff-command-brief-synthesizer-01-SUMMARY.md`; Task 3.1 (assumes Phase 1's threshold-feed-bridge test covers the per-session handoff-id case).
**Severity:** HIGH (blocker — direct dependency on Phase 1 fixes still in flight).

**H2a — SUMMARY filename mismatch.** Phase 1's CHECK.md L5 flagged the long-form SUMMARY filename as non-standard. Phase 2 adopts the **same long-form pattern** without verifying GSD's actual default. If Phase 1's revision changes its SUMMARY filename to short form (`01-SUMMARY.md`), Phase 2's `<phase_2_handoff_contract_inherited_from_phase_1>` block citing Phase 1's contract doc remains valid, but Phase 2's own output filename will diverge from whichever pattern Phase 1 settles on.

**H2b — handoff-id contract is asserted but not tested by Phase 1.** Phase 1's CHECK.md M5: the threshold-feed bridge does NOT assert the handoff scenario (two sessions both crossing 90%, two separate events with distinct sessionIds). Phase 2's listener (Task 3.1) leans on this contract heavily (D-03, dedup, T-02-11). If Phase 1's revision does NOT add the M5 test, Phase 2 ships dedup logic against an un-asserted upstream contract.

**Suggested fix.**
1. **For H2a:** Coordinate with Phase 1's planner; pick ONE SUMMARY-filename convention and apply consistently. Update Phase 2's `<output>` block accordingly.
2. **For H2b:** Add to Phase 2's `threshold-listener.test.ts` an explicit defense-in-depth test asserting that two trackers (different sessionIds) crossing 90% each enqueue independent approvals. ~30 LOC.
3. Add a sync-point note in `<phase_2_handoff_contract_inherited_from_phase_1>`: *"If Phase 1 ships without M5, Phase 2 owns the dedup-by-(sessionId, threshold) contract test in its own suite."*

---

## MEDIUM-SEVERITY FINDINGS

### M1. `metadata.threshold` string-vs-number conversion not specified
**Affects:** `must_haves` truth #3, Task 3.1 Step 2, `<interfaces>` `HandoffPromptPayload.thresholdPct: number`.
Phase 1 emits `metadata.threshold` as a STRING (`"90"`); `HandoffPromptPayload.thresholdPct` is a NUMBER. Plan does not specify the conversion site. **Fix:** add to Step 2: "parse `Number(entry.metadata.threshold)` for `thresholdPct` and `Number(entry.metadata.pct)` for the rendered pct — exactly once in the listener."

### M2. `--save` mode validation gate ambiguity
**Affects:** Task 4.1 mode dispatch step 1.
Does `--save` enforce the 8K hard token cap? Plan doesn't say. Strict means a too-long brief refuses to save (surprising). Permissive means `--save` runs only the secret-pattern check (recommended). **Fix:** pick permissive; pass `mode` into `validateBrief` or accept an explicit gate-level. Update Task 4.1 + tests.

### M3. "Pure synthesizer" claim qualified — `git log` shells out
**Affects:** Task 1.1 Step 1, RESEARCH §Pattern 1.
`getFilesTouchedByTicket` spawns `git log` via `NodeCommandInvoker` — a side effect / environment-dependent. The determinism test passes only because fixtures don't trigger git enrichment. On real channels, two back-to-back `buildBrief` calls 1 second apart could differ if a `git pull` ran in between. **Fix:** reframe in `<objective>` and JSDoc to "pure-over-declared-inputs"; add `gitLogEnabled?: boolean` opt; document non-bit-identicality on real channels in design doc.

### M4. D-02 v1-lossy annotation invisible at brief-render time
**Affects:** Task 1.1 (the user's check #4: clear "v1, lossy, revisit" annotation).
JSDoc covers code reviewers, but the brief itself shows a Files-touched section with no warning. **Fix:** render footnote in the section: `> *(v1: files-touched is reconstructed from git log; uncommitted changes and tickets without commit references are missing. Tracked: D-02.)*`. One-line in render-markdown.ts.

### M5. Stale-gap → placeholder path not tested through `buildBrief`
**Affects:** Task 0.1 / Task 1.1 (synthesizer.test.ts), the user's check #5.
Tests cover happy-path + Zod rejection + path-traversal + dual-call + timeout-then-placeholder. They do NOT chain a fresh fixture with a stale gap.json (capturedAt > 1h ago) through `buildBrief` to confirm the placeholder renders. A regression in staleness-to-placeholder wiring could pass all three component tests independently. **Fix:** add 15-line `it` to synthesizer.test.ts.

### M6. Codex spawn flags (orchestrator vs chat-mode) under-justified
**Affects:** Task 4.1 spawn helper.
Plan documents `codex exec -C <cwd> --skip-git-repo-check --sandbox read-only "<brief>"`. But `src/agents/cli-agents.ts:277-298` (the live Codex invocation) uses `--output-schema`, `-o`, `--ask-for-approval never`, optional `--model`. Plan does not say which to drop and why. **Fix:** add explicit note in Task 4.1: "The chat-seed invocation drops orchestrator-pipeline flags (`--output-schema`, `-o`, `--ask-for-approval`); sandbox stays `read-only` unless channel `fullAccess`; model from `profile.defaultModel`." Optionally extract `buildCodexChatArgv` helper.

### M7. `--resume <briefId>` reads brief.md but never uses content
**Affects:** Task 4.1 mode dispatch step 3.
Plan says "reads existing brief markdown + gap.json from disk." But `buildBrief` regenerates the deterministic skeleton from current channel state and only consumes `gap.json`. The brief.md is dead I/O. **Fix:** clarify "Read ONLY `<briefId>.gap.json`. The `.md` is a snapshot, not re-consumed. Optionally surface a footer `*Resumed from brief-XXX (originally generated YYYY-MM-DD)*` for provenance."

### M8. Threshold listener default poll interval (1s) too aggressive
**Affects:** Task 3.1 Step 2 (`pollIntervalMs?: number` default 1000).
For 5 active chat sessions polling at 1Hz, that's 5 readdir + 5 file-reads per second indefinitely. Context crossings are minutes-scale, not sub-second. **Fix:** default to 5000-10000ms; tests can override with `pollIntervalMs: 50`. Add comment.

### M9. No version-2 round-trip test on `schemaVersion` (analog to Phase 1 M1)
**Affects:** Task 0.1 / Task 2.1 (persistence.test.ts), the user's check #10.
Phase 2 introduces the FIRST versioned `~/.relay/` artifact (D-05). Phase 1's CHECK M1 mandated a version-2 round-trip test on the Rust side. Phase 2 has no analogous test for `HandoffBrief.schemaVersion` / `GapFillBlock.schemaVersion`. A future schemaVersion bump could be silently coerced to 1. **Fix:** add to persistence.test.ts:
```ts
it("preserves schemaVersion: 2 on round-trip (does not silently coerce to 1)", async () => {
  await writeFile(gapJsonPath, JSON.stringify({ schemaVersion: 2, /* ... */ }));
  const loaded = await readLatestGapFill(channelId, { now });
  expect(loaded).toBeNull();
});
```
Also: the MCP tool's Zod schema should reject `schemaVersion !== 1` explicitly at runtime.

### M10. `ApprovalKind` widening — cross-dashboard impact not audited
**Affects:** Task 3.1 Step 1, the user's check #6 ("extension safe?").
Adding `kind: "handoff-prompt"` widens the discriminated union. TUI/GUI render paths and possibly `crates/harness-data/` likely switch on `kind`. Kind-agnostic surfaces (`rly approve`, `rly reject`) are fine; *renderers* are not audited. AGENTS.md cross-dashboard contract: union widening is a cross-dashboard event. **Fix:** audit `tui/`, `gui/src/`, `gui/src-tauri/`, `crates/harness-data/` for `ApprovalKind`/`ApprovalRecord` switches. Either widen each (with placeholder rendering) or document fall-through behavior. Add `rly pending-approvals --json` test that renders a handoff-prompt approval correctly.

---

## LOW-SEVERITY FINDINGS

### L1. REQ-2.x ↔ HOFF-XX mapping never written down
RESEARCH uses `HOFF-01..06`; plan invents `REQ-2.1..2.10`. The mapping is implicit. **Fix:** one-liner in `<verification>` mapping each REQ-2.X to its HOFF-XX origin (and noting REQ-2.7..10 are net-new from CONTEXT/locked-decisions).

### L2. Wave 0 compile gap (same pattern as Phase 1 H2)
Task 0.1 acknowledges RED state; tests import from yet-to-exist Wave 1+ modules. `pnpm typecheck` over the test files fails. **Fix:** mirror whatever Phase 1's revision picks — stub modules with `export const X = undefined as any` (Wave 1 replaces) so typecheck passes and tests fail at runtime, OR collapse Wave 0 + Wave 1 into a single PR (sub-800 LOC if disciplined).

### L3. Wave 4 LOC estimate on the edge of 800
~700 (impl) + ~200 (test edits) = ~900. Plan acknowledges with "split spawn-helper if needed." **Fix:** pre-plan as Wave 4a (CLI handler + mode dispatch) and Wave 4b (spawn helpers + index.ts wiring).

### L4. `recordDecision` best-effort fallback untested
Plan says decision recording is best-effort. Untested. **Fix:** add 20-line `it` to handoff-cli.test.ts: `recordDecision throws → handoff still succeeds`.

### L5. `--wait-gap` UX: feed entry doesn't reach agent's prompt context
Posting `metadata.handoffPrompt: true` to feed is dashboard-visible, not agent-visible. Agent only sees its prompt. **Fix:** document explicitly in Task 4.1 step 1: agent learns to call `channel_handoff_finalize` via (a) system-prompt instruction in destination session's first turn, (b) proactive detection, or (c) user instruction — NOT via the feed entry. Brief MUST render with placeholders if none triggers fire.

### L6. Threshold listener self-post predicate disjointness
Listener polls feed AND posts to feed. Predicates ARE disjoint (`kind: context_threshold` vs `handoffPrompt: true`); no infinite loop. But not commented. **Fix:** add code comment: "Listener's own posts (`metadata.handoffPrompt: true`) are NOT matched by the context_threshold predicate — no self-loop."

### L7. `start_chat` Tauri-spawn idiom not version-pinned
Plan references `gui/src-tauri/src/lib.rs:1908` without pinning a version. **Fix:** add to Task 4.1: "TS spawner is independent of Tauri command; idiom referenced AS OF Phase 2 execution."

---

## Sync-points with Phase 1 revision (iteration 2)

| Phase 1 CHECK item | Phase 2 consequence |
|---|---|
| H1 (TUI dispatch parity) | None — same threshold-feed bridge regardless of dispatch path. |
| H2 (Wave 0 PR ordering) | Mirror whichever fix Phase 1 picks — see Phase 2 L2. |
| M1 (schemaVersion round-trip) | **Phase 2 should mirror on TS side** — see Phase 2 M9. |
| M3/M4 (kind field on budget.jsonl) | None — Phase 2 reads `feed.jsonl`, not `budget.jsonl`. |
| M5 (handoff-id contract test) | **Phase 2 inherits** — defense-in-depth on consumer side per H2b. |
| M8 (0% start guarantee) | Audit Phase 2's spawn helper (Wave 4) — fresh sessionId per spawn looks compliant; verify. |
| L5 (SUMMARY filename) | **Phase 2 should match** — see Phase 2 H2a. |

---

## Recommendation

**Status: NEEDS_REVISION.** Fix the two HIGH findings (H1: ApprovalsQueue.list API mismatch; H2: Phase 1 sync-points) before execution. MEDIUM findings batch into one revision pass — most are 1-3 lines or 15-30 LOC test additions. Estimated revision effort: 1-2 hours. After revision, plan is execution-ready.
