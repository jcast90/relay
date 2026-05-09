import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SPIKE_PATH = join(
  process.cwd(),
  ".planning",
  "phases",
  "01-token-usage-telemetry-context-bar",
  "01-SPIKE-A1.md"
);

const ADAPTER_PATH = join(process.cwd(), "src", "agents", "cli-agents.ts");

/**
 * Spike-snapshot test: parses the machine-readable header of
 * `01-SPIKE-A1.md` and asserts that the adapter's Codex parsing branch
 * matches the documented BRANCH=. Future re-spikes (when codex becomes
 * available) flip the header; this test holds Task 3 honest.
 *
 * RED in PR-1: PR-2's Task 3 implements the documented Codex parsing.
 * Until then, the adapter has no usage parsing at all and the grep
 * fails.
 */
describe("Codex --output-schema spike snapshot", () => {
  it("01-SPIKE-A1.md exists with the 5-line machine-readable header", () => {
    expect(existsSync(SPIKE_PATH)).toBe(true);
    const head = readFileSync(SPIKE_PATH, "utf8").split("\n").slice(0, 5);
    expect(head[0]).toMatch(/^BRANCH=(A|B|INCONCLUSIVE)$/);
    expect(head[1]).toMatch(/^STREAM_FLAG=/);
    expect(head[2]).toMatch(/^CODEX_VERSION=/);
    expect(head[3]).toMatch(/^SCHEMA_PATH=/);
    expect(head[4]).toMatch(/^USAGE_PRESENT=/);
  });

  it("Task 3's adapter implements the documented branch", () => {
    expect(existsSync(SPIKE_PATH)).toBe(true);
    const head = readFileSync(SPIKE_PATH, "utf8").split("\n").slice(0, 5);
    const branchLine = head[0] ?? "";
    const branch = branchLine.replace(/^BRANCH=/, "");
    const adapter = readFileSync(ADAPTER_PATH, "utf8");

    if (branch === "A" || branch === "INCONCLUSIVE") {
      // Branch A or INCONCLUSIVE: expect a top-level `usage` parse on
      // the response body. Task 3 lifts this in PR-2.
      expect(adapter).toMatch(/normalizeCodexUsage|response\.usage|response\["usage"\]|\.usage/);
    }
    if (branch === "B") {
      // Branch B: expect the JSONL stream parse with `turn.completed`.
      expect(adapter).toMatch(/turn\.completed|turn_completed/);
    }
    if (branch === "INCONCLUSIVE") {
      // M2: when INCONCLUSIVE the adapter MUST emit a stderr warning
      // when usage is missing post-Codex-run.
      expect(adapter).toMatch(/Codex usage extraction unavailable/);
    }
  });
});
