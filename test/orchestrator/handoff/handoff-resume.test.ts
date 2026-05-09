/**
 * RED test scaffold — turns GREEN in Wave 4 / PR-4 when
 * `src/cli/handoff.ts` ships the `--save` and `--resume` modes.
 *
 * Per Phase 2 PLAN Task 0.1 Step 5: encodes the success criteria for
 * D-08 (resume-after-week) and M7 (--resume reads only gap.json).
 */

import { describe, it } from "vitest";

describe.todo("rly handoff — `--save` + `--resume` modes (Wave 4)", () => {
  it("--save writes the brief artifact and does NOT spawn a destination session", () => {
    // - handleHandoffCommand({ argv: ["ch-fixmin-0001", "--save"], ... }).
    // - Expect brief artifacts on disk; spawner NOT called.
    // - Expect feed entry metadata.mode === "save".
    // - PERMISSIVE validation accepts a too-long brief without --force (M2).
  });

  it("--resume <briefId> --to claude reads ONLY <briefId>.gap.json (NOT <briefId>.md, per M7)", () => {
    // - Pre-place a saved gap.json + brief.md.
    // - Spy on fs.promises.readFile to assert the .md is NEVER opened.
    // - Expect new briefId distinct from the resume target.
    // - Expect new brief.resumedFrom = { briefId: <originalBriefId>, originalGeneratedAt }.
    // - Rendered markdown contains "**Resumed from:** brief-...".
    // - Spawner is called.
  });

  it("--resume latest --to claude resolves to the newest brief in handoffs/ dir", () => {
    // Pre-places three briefs with different timestamps; expects the newest to be the resume target.
  });
});
