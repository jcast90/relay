import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexCliAgent } from "../../src/agents/cli-agents.js";
import type {
  CommandInvocation,
  CommandInvoker,
  CommandResult,
} from "../../src/agents/command-invoker.js";
import type { AgentResult, WorkRequest } from "../../src/domain/agent.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/**
 * Codex `--output-schema` usage extraction. RED in PR-1: PR-2 (Task 3)
 * adds the `usage` parse to `CodexCliAgent.invokeProvider`. The
 * `STREAM_FLAG=NONE` warning case is gated on the spike's INCONCLUSIVE
 * branch (see `01-SPIKE-A1.md`).
 */
class FakeOutputSchemaInvoker implements CommandInvoker {
  readonly invocations: CommandInvocation[] = [];

  constructor(private readonly responseBody: unknown) {}

  async exec(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation);
    // Codex CLI writes its response JSON to the path passed via `-o
    // <out>`. The adapter then reads that file. Find the `-o` arg and
    // synthesize the file there.
    const oIdx = invocation.args.indexOf("-o");
    if (oIdx >= 0) {
      const outputPath = invocation.args[oIdx + 1];
      if (outputPath) {
        await writeFile(outputPath, JSON.stringify(this.responseBody));
      }
    }
    return {
      stdout: JSON.stringify(this.responseBody),
      stderr: "",
      exitCode: 0,
    };
  }
}

function makeWorkRequest(): WorkRequest {
  return {
    runId: "run-codex-usage",
    phaseId: "phase-1",
    kind: "implement_phase",
    specialty: "general",
    title: "codex usage extraction",
    objective: "extract usage from response.json",
    acceptanceCriteria: [],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    context: [],
    artifactContext: [],
    attempt: 1,
    maxAttempts: 3,
    priorEvidence: [],
  };
}

describe("CodexCliAgent — usage extraction (D-07 / Branch A)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "relay-codex-usage-"));
  });

  afterEach(async () => {
    await rm(cwd, RM_OPTS);
  });

  it("populates AgentResult.tokenUsage from response.json top-level usage block", async () => {
    const invoker = new FakeOutputSchemaInvoker({
      summary: "ok",
      evidence: [],
      proposedCommands: [],
      blockers: [],
      usage: { input_tokens: 800, output_tokens: 120 },
    });
    const agent = new CodexCliAgent({
      id: "codex-1",
      name: "Codex",
      provider: "codex",
      capability: { role: "implementer", specialties: ["general"] },
      cwd,
      invoker: invoker as unknown as CommandInvoker,
    });

    const result = (await agent.run(makeWorkRequest())) as AgentResult;
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBe(800);
    expect(result.tokenUsage?.outputTokens).toBe(120);
  });

  it("does not throw when usage is missing (older Codex versions)", async () => {
    const invoker = new FakeOutputSchemaInvoker({
      summary: "ok",
      evidence: [],
      proposedCommands: [],
      blockers: [],
    });
    const agent = new CodexCliAgent({
      id: "codex-2",
      name: "Codex",
      provider: "codex",
      capability: { role: "implementer", specialties: ["general"] },
      cwd,
      invoker: invoker as unknown as CommandInvoker,
    });

    const result = (await agent.run(makeWorkRequest())) as AgentResult;
    expect(result.tokenUsage).toBeUndefined();
  });

  it("emits a [budget] stderr warning when usage is unavailable post-Codex-run (M2 INCONCLUSIVE branch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const invoker = new FakeOutputSchemaInvoker({
        summary: "ok",
        evidence: [],
        proposedCommands: [],
        blockers: [],
      });
      const agent = new CodexCliAgent({
        id: "codex-3",
        name: "Codex",
        provider: "codex",
        capability: { role: "implementer", specialties: ["general"] },
        cwd,
        invoker: invoker as unknown as CommandInvoker,
      });

      await agent.run(makeWorkRequest());
      const calls = warn.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => /\[budget\].*Codex usage extraction unavailable/.test(m))).toBe(
        true
      );
    } finally {
      warn.mockRestore();
    }
  });
});
