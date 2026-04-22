import { describe, expect, it } from "vitest";

import { ClaudeCliAgent, appendDisallowedBuiltinArgs } from "../../src/agents/cli-agents.js";
import type { CommandInvoker, CommandInvocation } from "../../src/agents/command-invoker.js";
import { agentResultJsonSchema } from "../../src/domain/agent.js";

/**
 * AL-11 (B1 fix) — verify that when a restricted role is configured on a
 * Claude CLI agent, the CLI is actually spawned with the `--disallowed-tools`
 * flag AND with `RELAY_AGENT_ROLE` set in its env.
 *
 * Why this matters: Claude's built-in tools (Edit, Write, Bash, NotebookEdit)
 * run in-process in the `claude` CLI and never round-trip through our MCP
 * JSON-RPC boundary. The role-allowlist module can't see them, so the MCP
 * allowlist alone is cosmetic for that attack surface. The only way to gate
 * them is to pass `--disallowed-tools` to the CLI at spawn time.
 *
 * These tests use a scripted invoker that captures the invocation without
 * actually running the Claude binary, then replays a canned success response
 * so the agent returns normally.
 */

class CapturingInvoker implements CommandInvoker {
  readonly invocations: CommandInvocation[] = [];
  constructor(private readonly stdout: string) {}
  async exec(invocation: CommandInvocation) {
    this.invocations.push(invocation);
    return { stdout: this.stdout, stderr: "", exitCode: 0 };
  }
}

/** Minimal valid AgentResult JSON so `normalizePayload` doesn't reject it. */
const CANNED_STDOUT = JSON.stringify({
  summary: "noop",
  evidence: [],
  proposedCommands: [],
  blockers: [],
});

function buildAgent(role: string | undefined, invoker: CommandInvoker) {
  return new ClaudeCliAgent({
    id: "atlas",
    name: "Atlas (Planner)",
    provider: "claude",
    capability: { role: "planner", specialties: ["general"] },
    cwd: "/tmp/fake-repo",
    invoker,
    role,
  });
}

const DUMMY_REQUEST = {
  runId: "run-1",
  phaseId: "phase-1",
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
};

describe("ClaudeCliAgent — role-driven built-in lockdown (AL-11 B1)", () => {
  it("without a role, does NOT add --disallowed-tools (pre-AL-11 parity)", async () => {
    const invoker = new CapturingInvoker(CANNED_STDOUT);
    const agent = buildAgent(undefined, invoker);
    await agent.run(DUMMY_REQUEST);

    expect(invoker.invocations).toHaveLength(1);
    const args = invoker.invocations[0].args;
    expect(args).not.toContain("--disallowed-tools");

    // Env overlay must also be absent -- we don't want to accidentally set
    // RELAY_AGENT_ROLE for unrestricted sessions.
    expect(invoker.invocations[0].env).toBeUndefined();
  });

  it("with role=repo-admin, appends --disallowed-tools Edit,Write,NotebookEdit,Bash", async () => {
    const invoker = new CapturingInvoker(CANNED_STDOUT);
    const agent = buildAgent("repo-admin", invoker);
    await agent.run(DUMMY_REQUEST);

    const args = invoker.invocations[0].args;
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    // The value MUST be the next argv slot -- CLI parsers want
    // `--flag value`, not `--flag=value`, per the rest of our args.
    expect(args[flagIdx + 1]).toBe("Edit,Write,NotebookEdit,Bash");
  });

  it("with role=repo-admin, --disallowed-tools lands BEFORE the prompt positional arg", async () => {
    // The prompt is the very last arg the CLI sees. If --disallowed-tools
    // and its value end up AFTER the prompt, the CLI treats them as extra
    // positional args and the flag is silently ignored. Guard against that.
    const invoker = new CapturingInvoker(CANNED_STDOUT);
    const agent = buildAgent("repo-admin", invoker);
    await agent.run(DUMMY_REQUEST);

    const args = invoker.invocations[0].args;
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    // Last arg is the prompt; it must sit strictly after the flag's value.
    expect(flagIdx + 1).toBeLessThan(args.length - 1);
  });

  it("with role=repo-admin, sets RELAY_AGENT_ROLE in the subprocess env overlay", async () => {
    const invoker = new CapturingInvoker(CANNED_STDOUT);
    const agent = buildAgent("repo-admin", invoker);
    await agent.run(DUMMY_REQUEST);

    const env = invoker.invocations[0].env;
    expect(env).toEqual({ RELAY_AGENT_ROLE: "repo-admin" });
  });

  it("with role=repo-admin, does NOT drop args the unrestricted path already required", async () => {
    // Regression guard: the AL-11 wiring must only ADD to the arg list, not
    // replace existing pieces. If --json-schema or -p disappear, the CLI
    // call breaks silently.
    const invoker = new CapturingInvoker(CANNED_STDOUT);
    const agent = buildAgent("repo-admin", invoker);
    await agent.run(DUMMY_REQUEST);

    const args = invoker.invocations[0].args;
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain(JSON.stringify(agentResultJsonSchema));
  });

  it("with an unknown role, does NOT add --disallowed-tools (fall-through path)", async () => {
    // Unknown roles intentionally fall through to unrestricted today (the
    // map opt-in model for AL-12..16 rollout). The server-side I1 fix
    // warns about this on stderr, but the adapter itself shouldn't guess at
    // a deny list.
    const invoker = new CapturingInvoker(CANNED_STDOUT);
    const agent = buildAgent("eng-manager", invoker);
    await agent.run(DUMMY_REQUEST);

    const args = invoker.invocations[0].args;
    expect(args).not.toContain("--disallowed-tools");
  });
});

describe("appendDisallowedBuiltinArgs - pure helper", () => {
  it("no-ops when role is undefined", () => {
    const args: string[] = ["-p"];
    appendDisallowedBuiltinArgs(args, undefined);
    expect(args).toEqual(["-p"]);
  });

  it("no-ops when role has no built-in lockdown configured", () => {
    const args: string[] = ["-p"];
    appendDisallowedBuiltinArgs(args, "eng-manager");
    expect(args).toEqual(["-p"]);
  });

  it("appends the canonical repo-admin deny list in-place", () => {
    const args: string[] = ["-p", "--output-format", "json"];
    appendDisallowedBuiltinArgs(args, "repo-admin");
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--disallowed-tools",
      "Edit,Write,NotebookEdit,Bash",
    ]);
  });
});
