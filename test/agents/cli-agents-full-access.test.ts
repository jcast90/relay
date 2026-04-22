import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCliAgent, CodexCliAgent } from "../../src/agents/cli-agents.js";
import type { CommandInvocation, CommandInvoker } from "../../src/agents/command-invoker.js";
import type { WorkRequest } from "../../src/domain/agent.js";

/**
 * AL-0: the per-channel `fullAccess` flag must reach the subprocess launch
 * as `--dangerously-skip-permissions` (Claude) / `--full-auto` (Codex),
 * regardless of the host's `RELAY_AUTO_APPROVE` env var. These tests
 * capture the args passed to a fake `CommandInvoker` and assert the right
 * flag appears (or doesn't) under every combination of channel-flag +
 * env-flag.
 */

class CaptureInvoker implements CommandInvoker {
  public lastInvocation: CommandInvocation | null = null;

  constructor(private readonly stdout: string) {}

  async exec(invocation: CommandInvocation) {
    this.lastInvocation = invocation;

    // Codex writes its response to the `-o` path, so mirror the real CLI's
    // contract: drop the JSON payload there before returning. Claude reads
    // from stdout and needs no tempfile.
    const outputFlagIdx = invocation.args.indexOf("-o");
    if (outputFlagIdx >= 0) {
      const outputPath = invocation.args[outputFlagIdx + 1];
      if (outputPath) {
        await writeFile(outputPath, this.stdout);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    return { stdout: this.stdout, stderr: "", exitCode: 0 };
  }
}

function makeWorkRequest(): WorkRequest {
  return {
    runId: "run-1",
    phaseId: "phase-1",
    kind: "implement_phase",
    specialty: "general",
    title: "test",
    objective: "test",
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

const AGENT_RESULT = JSON.stringify({
  summary: "ok",
  evidence: [],
  proposedCommands: [],
  blockers: [],
});

describe("cli-agents full-access flag (AL-0)", () => {
  const priorEnv = process.env.RELAY_AUTO_APPROVE;

  beforeEach(() => {
    // Every test sets its own env expectation; start from a known-clean
    // slate so the host's RELAY_AUTO_APPROVE never leaks into the assertions.
    delete process.env.RELAY_AUTO_APPROVE;
  });

  afterEach(() => {
    if (priorEnv === undefined) {
      delete process.env.RELAY_AUTO_APPROVE;
    } else {
      process.env.RELAY_AUTO_APPROVE = priorEnv;
    }
  });

  it("Claude: fullAccess=true threads --dangerously-skip-permissions even with env unset", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agent = new ClaudeCliAgent({
      id: "a-1",
      name: "A",
      provider: "claude",
      capability: { role: "implementer", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      fullAccess: true,
    });

    await agent.run(makeWorkRequest());

    const args = invoker.lastInvocation?.args ?? [];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  it("Claude: fullAccess=false + env unset uses default permission mode", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agent = new ClaudeCliAgent({
      id: "a-1",
      name: "A",
      provider: "claude",
      capability: { role: "implementer", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      fullAccess: false,
    });

    await agent.run(makeWorkRequest());

    const args = invoker.lastInvocation?.args ?? [];
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--permission-mode");
  });

  it("Claude: fullAccess omitted behaves as false", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agent = new ClaudeCliAgent({
      id: "a-1",
      name: "A",
      provider: "claude",
      capability: { role: "implementer", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
    });

    await agent.run(makeWorkRequest());

    const args = invoker.lastInvocation?.args ?? [];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("Claude: env-based auto-approve still works when fullAccess is off (back-compat)", async () => {
    process.env.RELAY_AUTO_APPROVE = "1";
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agent = new ClaudeCliAgent({
      id: "a-1",
      name: "A",
      provider: "claude",
      capability: { role: "implementer", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      fullAccess: false,
    });

    await agent.run(makeWorkRequest());

    const args = invoker.lastInvocation?.args ?? [];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("Codex: fullAccess=true threads --full-auto and --ask-for-approval never", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agent = new CodexCliAgent({
      id: "a-1",
      name: "A",
      provider: "codex",
      capability: { role: "implementer", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      fullAccess: true,
    });

    await agent.run(makeWorkRequest());

    const args = invoker.lastInvocation?.args ?? [];
    // Codex's "full access" is the combination of a writable sandbox +
    // never-ask approval policy. Both signals need to be on the command line.
    expect(args).toContain("workspace-write");
    expect(args).toContain("--ask-for-approval");
    expect(args[args.indexOf("--ask-for-approval") + 1]).toBe("never");
  });

  it("Codex: fullAccess=false keeps the default read-only sandbox", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agent = new CodexCliAgent({
      id: "a-1",
      name: "A",
      provider: "codex",
      capability: { role: "implementer", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      fullAccess: false,
    });

    await agent.run(makeWorkRequest());

    const args = invoker.lastInvocation?.args ?? [];
    expect(args).toContain("read-only");
    expect(args).not.toContain("--ask-for-approval");
  });
});
