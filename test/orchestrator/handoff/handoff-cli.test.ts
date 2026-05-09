/**
 * RED test scaffold — turns GREEN in Wave 4 / PR-4 when
 * `src/cli/handoff.ts` lands.
 *
 * Per Phase 2 PLAN Task 0.1 Step 5: this file encodes the success
 * criteria for the `rly handoff` CLI handler under `--to <value>` mode.
 * Wave 4a covers the handler + mode dispatch; Wave 4b adds the spawn
 * helpers + index.ts wiring. Both trigger these tests turning green.
 */

import { describe, it } from "vitest";

describe.todo("rly handoff — `--to <value>` happy path (Wave 4)", () => {
  it("--to claude writes brief artifacts and dispatches with the brief as first turn", () => {
    // - Build the fixture channel layout in a tmp ~/.relay/.
    // - Stub spawner that records its calls.
    // - handleHandoffCommand({ argv: ["ch-fixmin-0001", "--to", "claude"], ... }).
    // - Expect brief artifacts at <tmp>/channels/ch-fixmin-0001/handoffs/<briefId>.{md,gap.json}.
    // - Expect spawner called with adapter "claude" and the brief markdown as the first-turn arg.
    // - Expect a feed entry of type "status_update" with metadata.handoff === true.
    // - Expect exit code 0.
  });

  it("--to codex argv assembled by buildCodexChatArgv drops --output-schema / -o / --ask-for-approval (M6)", () => {
    // Asserts that the chat-seed argv path differs from the orchestrator-pipeline path.
  });

  it("--to <unknown> exits non-zero with the D-03 layered fallback error string", () => {
    // Resolution: provider profile id → adapter name → channel repo alias → error.
  });

  it("secret-pattern in fixture decision exits non-zero in BOTH STRICT and PERMISSIVE; --force does not bypass", () => {
    // Defense-in-depth: secret-pattern is HARD in BOTH modes (D-09).
  });

  it("--json mode emits a single-line JSON envelope on stdout", () => {
    // RESEARCH §Q16 — { ok: true, channelId, briefId, briefPath, fromSessionId, toSessionId, toProvider, tokenEstimate }.
  });

  it("--wait-gap 100 with no gap-fill arrives renders with [gap-fill not provided] placeholder", () => {
    // D-06 fallback — brief MUST render successfully without gap-fill.
  });

  it("recordDecision throws → handoff still succeeds (L4 best-effort)", () => {
    // Wraps the channel store with a failing recordDecision; the brief still dispatches and exits 0.
  });
});
