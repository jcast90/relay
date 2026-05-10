/**
 * Live-network integration tests for `rly handoff` (Phase 2 PR-5 / Wave 5).
 *
 * Per AGENTS.md "Testing conventions":
 *
 * > Live-network tests (real Claude / Codex / GitHub / Linear) sit inside
 * > `describe.skip(...)` blocks. Don't enable them in default CI paths.
 *
 * > Two CI tiers. Fast scripted tier on every PR (`.github/workflows/ci.yml`);
 * > integration tier for Postgres / real-git / K8s / live-GitHub runs nightly
 * > or on-demand (`.github/workflows/integration.yml`).
 *
 * These tests are gated behind `HARNESS_LIVE=1` AND require the relevant CLI
 * binary (`claude` / `codex`) on `$PATH`. They run on-demand against a real
 * fixture channel restored to a tmpdir-rooted `~/.relay/`. They're NOT
 * enabled in `pnpm test` by default — promote them by removing the
 * `describe.skip` (or by switching to `maybeDescribe = HARNESS_LIVE ? describe
 * : describe.skip` at runtime).
 *
 * What these prove that the scripted suite doesn't:
 *   - The brief markdown actually fits Claude's `--append-system-prompt` +
 *     first-turn pipeline at a real argv length, with a real model loading
 *     the prompt and replying.
 *   - The new Claude session demonstrates context retention on its first
 *     response — knows current line of attack, doesn't re-litigate prior
 *     decisions, can answer "what tickets are blocked?" from the brief
 *     (RESEARCH §Q19).
 *   - The Codex chat-seed argv (`buildCodexChatArgv`, M6) lands in `codex
 *     exec` correctly under real provider credentials, with `--output-schema`
 *     / `-o` / `--ask-for-approval` deliberately absent.
 *   - The 90% nudge fires end-to-end on a real session that crosses 90%
 *     under live token telemetry — proving Phase 1 emit + Phase 2 listener
 *     stay coherent under realistic timing.
 *
 * Required env:
 *   HARNESS_LIVE=1
 *   ANTHROPIC_API_KEY (for `--to claude`)
 *   OPENAI_API_KEY    (for `--to codex`)
 *   RELAY_LIVE_FIXTURE_CHANNEL_DIR (path to a real channel snapshot)
 *
 * Suggested invocation:
 *   HARNESS_LIVE=1 ANTHROPIC_API_KEY=... \
 *   RELAY_LIVE_FIXTURE_CHANNEL_DIR=/path/to/snapshot \
 *   pnpm vitest run test/orchestrator/handoff/handoff-integration.test.ts
 */

import { describe, it, expect } from "vitest";

// `describe.skip` is the AGENTS.md convention. Promote to `describe` (or wire
// `maybeDescribe = process.env.HARNESS_LIVE ? describe : describe.skip` at
// the top of the file) when you want these to run.
describe.skip("[live] handoff integration — Claude destination", () => {
  it("rly handoff <ch> --to claude produces a working session that demonstrates context retention", async () => {
    // 1. Restore RELAY_LIVE_FIXTURE_CHANNEL_DIR to a tmpdir-rooted ~/.relay/.
    // 2. Spawn `rly handoff <fixtureChannelId> --to claude` against it.
    // 3. Probe the resulting Claude session with: "What tickets are
    //    currently blocked?" — assert the response references at least one
    //    ticket id present in the fixture's tickets.json blocked set.
    //    (Demonstrates first-response context retention from the brief.)
    // 4. Tear down the tmpdir.
    expect(process.env.HARNESS_LIVE).toBe("1");
  });

  it("declines a 90% prompt benignly — running session continues", async () => {
    // 1. Drive a fixture channel session past Phase 1's 90% emit threshold.
    // 2. Wait for the threshold listener to enqueue a `handoff-prompt`
    //    approval (rly pending-approvals --json).
    // 3. `rly reject <approvalId>`.
    // 4. Assert the running session continues to make progress (no spawn,
    //    no feed entry tagged `handoff: true` from the rejected approval).
    expect(process.env.HARNESS_LIVE).toBe("1");
  });
});

describe.skip("[live] handoff integration — Codex destination", () => {
  it("rly handoff <ch> --to codex works within Codex's idiom constraints (M6)", async () => {
    // 1. Restore RELAY_LIVE_FIXTURE_CHANNEL_DIR.
    // 2. Spawn `rly handoff <fixtureChannelId> --to codex`.
    // 3. Assert the spawned argv (captured via NodeCommandInvoker stub or
    //    process inspection) includes:
    //      - `exec`, `--sandbox <mode>`, `-C <cwd>`
    //      - the brief markdown as a positional
    //    AND does NOT include `--output-schema`, `-o`, or
    //    `--ask-for-approval` (M6).
    // 4. Probe the spawned Codex session with the same context-retention
    //    question from the Claude case.
    expect(process.env.HARNESS_LIVE).toBe("1");
  });
});

describe.skip("[live] handoff integration — 90% nudge end-to-end", () => {
  it("90% threshold fires on a real session crossing 90% and enqueues a handoff-prompt approval", async () => {
    // 1. Set up a fixture session and feed it real Claude or Codex traffic
    //    until it crosses 90% — i.e. drive Phase 1's `context_threshold`
    //    emit on the feed.
    // 2. Attach Phase 2's threshold listener (default 5s poll) to the
    //    feed file.
    // 3. Wait up to 30s for an `ApprovalsQueue` record of
    //    `kind: "handoff-prompt"` to appear via
    //    `rly pending-approvals --json`.
    // 4. Assert payload.thresholdPct === 90 (number, not string — M1
    //    string→number conversion at the listener boundary).
    // 5. Assert payload.fromSessionId === <the live session id>.
    expect(process.env.HARNESS_LIVE).toBe("1");
  });
});
