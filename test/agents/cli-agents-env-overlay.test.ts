import { describe, expect, it } from "vitest";

import { ClaudeCliAgent, CodexCliAgent } from "../../src/agents/cli-agents.js";
import type {
  CommandInvocation,
  CommandInvoker,
  CommandResult,
} from "../../src/agents/command-invoker.js";
import { ScriptedInvoker } from "../../src/simulation/scripted-invoker.js";
import type { WorkRequest } from "../../src/domain/agent.js";

/**
 * PR 2: verify the profile plumbing (`envOverlay` + `extraPassEnv`) reaches
 * the `CommandInvocation` the adapter hands to the invoker. Wraps the real
 * `ScriptedInvoker` so the scripted JSON response keeps the adapters happy
 * while we snapshot every invocation for assertions.
 */
class CapturingScriptedInvoker implements CommandInvoker {
  readonly invocations: CommandInvocation[] = [];
  private readonly inner: ScriptedInvoker;

  constructor(cwd: string) {
    this.inner = new ScriptedInvoker(cwd);
  }

  async exec(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation);
    return this.inner.exec(invocation);
  }
}

function makeWorkRequest(): WorkRequest {
  return {
    runId: "run-1",
    phaseId: "phase-1",
    kind: "implement_phase",
    specialty: "general",
    title: "env-overlay test",
    objective: "verify env overlay + passEnv propagation",
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

describe("cli-agents envOverlay + extraPassEnv (PR2 profile plumbing)", () => {
  it("Claude: envOverlay entries reach the CommandInvocation.env", async () => {
    const invoker = new CapturingScriptedInvoker(process.cwd());
    const agent = new ClaudeCliAgent({
      id: "atlas",
      name: "Atlas",
      provider: "claude",
      capability: { role: "planner", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      envOverlay: {
        ANTHROPIC_BASE_URL: "https://proxy.example.com",
        ANTHROPIC_MODEL: "claude-sonnet-4",
      },
    });

    await agent.run(makeWorkRequest());

    const call = invoker.invocations.at(-1);
    expect(call?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      ANTHROPIC_MODEL: "claude-sonnet-4",
    });
  });

  it("Claude: envOverlay merges with RELAY_AGENT_ROLE when a role is set", async () => {
    const invoker = new CapturingScriptedInvoker(process.cwd());
    const agent = new ClaudeCliAgent({
      id: "atlas",
      name: "Atlas",
      provider: "claude",
      capability: { role: "planner", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      role: "repo-admin",
      envOverlay: { ANTHROPIC_BASE_URL: "https://proxy.example.com" },
    });

    await agent.run(makeWorkRequest());

    const call = invoker.invocations.at(-1);
    expect(call?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      RELAY_AGENT_ROLE: "repo-admin",
    });
  });

  it("Claude: extraPassEnv is appended to the default CLAUDE_PASS_ENV list", async () => {
    const invoker = new CapturingScriptedInvoker(process.cwd());
    const agent = new ClaudeCliAgent({
      id: "atlas",
      name: "Atlas",
      provider: "claude",
      capability: { role: "planner", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      extraPassEnv: ["OPENROUTER_API_KEY"],
    });

    await agent.run(makeWorkRequest());

    const call = invoker.invocations.at(-1);
    const passEnv = call?.passEnv ?? [];
    expect(passEnv).toContain("OPENROUTER_API_KEY");
    expect(passEnv).toContain("ANTHROPIC_API_KEY");
  });

  it("Codex: envOverlay + extraPassEnv both reach the invocation", async () => {
    const invoker = new CapturingScriptedInvoker(process.cwd());
    const agent = new CodexCliAgent({
      id: "atlas",
      name: "Atlas",
      provider: "codex",
      capability: { role: "planner", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
      envOverlay: { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" },
      extraPassEnv: ["OPENROUTER_API_KEY"],
    });

    await agent.run(makeWorkRequest());

    const call = invoker.invocations.at(-1);
    expect(call?.env).toMatchObject({
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    });
    const passEnv = call?.passEnv ?? [];
    expect(passEnv).toContain("OPENROUTER_API_KEY");
    expect(passEnv).toContain("OPENAI_API_KEY");
  });

  it("omitting both options leaves env + passEnv untouched from the pre-PR2 defaults", async () => {
    const invoker = new CapturingScriptedInvoker(process.cwd());
    const agent = new ClaudeCliAgent({
      id: "atlas",
      name: "Atlas",
      provider: "claude",
      capability: { role: "planner", specialties: ["general"] },
      cwd: process.cwd(),
      invoker,
    });

    await agent.run(makeWorkRequest());

    const call = invoker.invocations.at(-1);
    // No role set, no overlay: env should be undefined (pre-AL-11 parity).
    expect(call?.env).toBeUndefined();
    const passEnv = call?.passEnv ?? [];
    // Default list only — no extras appended.
    expect(passEnv).toContain("ANTHROPIC_API_KEY");
    expect(passEnv).not.toContain("OPENROUTER_API_KEY");
  });
});
