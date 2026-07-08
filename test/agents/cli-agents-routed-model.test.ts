import { describe, expect, it } from "vitest";

import { ClaudeCliAgent } from "../../src/agents/cli-agents.js";
import type { CommandInvoker, CommandInvocation } from "../../src/agents/command-invoker.js";

class CapturingInvoker implements CommandInvoker {
  readonly invocations: CommandInvocation[] = [];
  constructor(private readonly stdout: string) {}
  async exec(invocation: CommandInvocation) {
    this.invocations.push(invocation);
    return { stdout: this.stdout, stderr: "", exitCode: 0 };
  }
}

const CANNED = JSON.stringify({ summary: "ok", evidence: [], proposedCommands: [], blockers: [] });

function baseRequest(model?: string) {
  return {
    runId: "run-1",
    phaseId: "t-1",
    kind: "implement_phase" as const,
    specialty: "general" as const,
    attempt: 1,
    maxAttempts: 3,
    title: "noop",
    objective: "test",
    acceptanceCriteria: [],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    context: [],
    artifactContext: [],
    priorEvidence: [],
    ...(model ? { model } : {}),
  };
}

function agent(invoker: CommandInvoker, configuredModel?: string) {
  return new ClaudeCliAgent({
    id: "atlas",
    name: "Atlas",
    provider: "claude",
    capability: { role: "planner", specialties: ["general"] },
    cwd: "/tmp/fake-repo",
    invoker,
    model: configuredModel,
  });
}

function modelArg(args: string[]): string | undefined {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
}

describe("ClaudeCliAgent honors the routed per-call model", () => {
  it("passes request.model as --model, overriding the configured model", async () => {
    const invoker = new CapturingInvoker(CANNED);
    const result = await agent(invoker, "claude-sonnet-4-5").run(baseRequest("claude-haiku-3-5"));

    expect(modelArg(invoker.invocations[0]!.args)).toBe("claude-haiku-3-5");
    // The result is tagged with the model that actually ran (the routed one).
    expect(result.model).toBe("claude-haiku-3-5");
  });

  it("falls back to the configured model when no override is set", async () => {
    const invoker = new CapturingInvoker(CANNED);
    const result = await agent(invoker, "claude-sonnet-4-5").run(baseRequest());

    expect(modelArg(invoker.invocations[0]!.args)).toBe("claude-sonnet-4-5");
    expect(result.model).toBe("claude-sonnet-4-5");
  });
});
