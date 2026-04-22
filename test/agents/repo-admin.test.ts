import { beforeEach, describe, expect, it } from "vitest";

import {
  REPO_ADMIN_ALLOWED_TOOLS,
  REPO_ADMIN_COORDINATION_POLICY_MARKER,
  REPO_ADMIN_MEMORY_POLICY_MARKER,
  REPO_ADMIN_ROLE,
  REPO_ADMIN_SPECIALTY,
  REPO_ADMIN_TOOL_STUBS,
  buildRepoAdminSystemPrompt,
  spawnWorkerStub,
} from "../../src/agents/repo-admin.js";
import {
  __resetUnknownRoleWarningsForTests,
  allowlistForRole,
  denyToolEnvelope,
  getDisallowedBuiltinsForRole,
  isKnownRole,
  isToolAllowedForRole,
  resolveCurrentRole,
  warnIfUnknownRole,
} from "../../src/mcp/role-allowlist.js";

/**
 * AL-11 role-definition tests.
 *
 * These tests pin the repo-admin role surface: the exact allowlist set,
 * the system-prompt phrasing that encodes the board-is-memory policy, and
 * the shape of the structured denial envelope. Later tickets (AL-12..16)
 * extend this; these assertions make any silent drift fail CI.
 */

describe("repo-admin role — identity", () => {
  it("tags the specialty as repo_admin (matches the zod enum)", () => {
    expect(REPO_ADMIN_SPECIALTY).toBe("repo_admin");
  });

  it("pins the MCP role name", () => {
    expect(REPO_ADMIN_ROLE).toBe("repo-admin");
  });
});

describe("repo-admin role — allowlist exactness", () => {
  /**
   * The brief calls out the five capability buckets (read board, read
   * decisions, read git log, spawn workers, query PR state). We exercise
   * the set directly — adding a tool to the whitelist is a real design
   * change and should require updating this test deliberately.
   */
  it("exposes exactly the expected MCP tool names and nothing else", () => {
    const sorted = [...REPO_ADMIN_ALLOWED_TOOLS].sort();
    expect(sorted).toEqual(
      [
        "channel_get", // read decisions + feed + run links in one call
        "channel_post", // append-only feed updates (propose a spawn, announce a decision)
        "channel_task_board", // read the ticket board
        "coordination_send", // AL-16: typed inter-repo coordination messages
        "harness_get_run_detail", // read-only run state
        "harness_list_runs", // read-only run index
        "harness_running_tasks", // cross-workspace running-task view
        "spawn_worker", // name only — AL-14 fills in the handler
      ].sort()
    );
  });

  it("blocks every denied tool called out by the brief", () => {
    // Editor tools — repo-admin never edits files.
    expect(isToolAllowedForRole("repo-admin", "Edit")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "Write")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "NotebookEdit")).toBe(false);

    // Test runners / PR merges — delegated to workers / humans, not admins.
    expect(isToolAllowedForRole("repo-admin", "Bash")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "pnpm_test")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "gh_pr_merge")).toBe(false);

    // Mutating MCP tools outside spawn_worker.
    expect(isToolAllowedForRole("repo-admin", "harness_dispatch")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "harness_approve_plan")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "harness_reject_plan")).toBe(false);
    expect(isToolAllowedForRole("repo-admin", "project_create")).toBe(false);
  });

  it("allows every listed tool", () => {
    for (const tool of REPO_ADMIN_ALLOWED_TOOLS) {
      expect(isToolAllowedForRole("repo-admin", tool)).toBe(true);
    }
  });

  it("allowlistForRole returns the same concrete set", () => {
    const set = allowlistForRole("repo-admin");
    expect(set).not.toBeNull();
    expect(set).toBe(REPO_ADMIN_ALLOWED_TOOLS);
  });

  it("absent role (RELAY_AGENT_ROLE unset) stays unrestricted", () => {
    // resolveCurrentRole returns null when the env var is absent or blank.
    expect(resolveCurrentRole({})).toBeNull();
    expect(resolveCurrentRole({ RELAY_AGENT_ROLE: "" })).toBeNull();
    expect(resolveCurrentRole({ RELAY_AGENT_ROLE: "   " })).toBeNull();

    // No role -> everything allowed (preserves pre-AL-11 behaviour).
    expect(isToolAllowedForRole(null, "Edit")).toBe(true);
    expect(isToolAllowedForRole(null, "Bash")).toBe(true);
  });

  it("unknown role passes through (no silent denial)", () => {
    // AL-12..16 will add more roles. Until they do, unknown roles are
    // unrestricted so nothing else regresses during rollout.
    expect(isToolAllowedForRole("eng-manager", "Edit")).toBe(true);
    expect(isToolAllowedForRole("atlas", "Bash")).toBe(true);
  });

  it("resolveCurrentRole returns the trimmed role when set", () => {
    expect(resolveCurrentRole({ RELAY_AGENT_ROLE: "repo-admin" })).toBe("repo-admin");
    expect(resolveCurrentRole({ RELAY_AGENT_ROLE: "  repo-admin  " })).toBe("repo-admin");
  });
});

describe("repo-admin role — denial envelope shape", () => {
  it("returns a structured tool-not-allowed envelope, not a string or silent pass", () => {
    const envelope = denyToolEnvelope("repo-admin", "Edit");

    expect(envelope).toEqual({
      error: "tool-not-allowed",
      tool: "Edit",
      role: "repo-admin",
      reason: expect.any(String),
    });
    // Reason must actually mention the role-specific guidance so the agent
    // can act on it rather than flailing.
    expect(envelope.reason).toMatch(/repo-admin/i);
    expect(envelope.reason.toLowerCase()).toContain("worker");
  });

  it("produces a generic reason for roles without bespoke copy", () => {
    const envelope = denyToolEnvelope("eng-manager", "Edit");
    expect(envelope.error).toBe("tool-not-allowed");
    expect(envelope.reason).toContain("eng-manager");
    expect(envelope.reason).toContain("Edit");
  });
});

describe("repo-admin role — system prompt", () => {
  const prompt = buildRepoAdminSystemPrompt({ repoPath: "/tmp/my-repo" });

  it("frames the role as coordination, not implementation", () => {
    expect(prompt).toContain("repo-admin for `/tmp/my-repo`");
    expect(prompt).toContain("coordination, not implementation");
  });

  it("encodes the board-is-memory policy by substring match", () => {
    // Pin the exact marker the role module exports so future edits can't
    // silently drop the memory-policy guidance without tripping this test.
    expect(prompt).toContain(REPO_ADMIN_MEMORY_POLICY_MARKER);
    // Plus the supporting language the brief calls out verbatim.
    expect(prompt).toContain("cache only the active working set");
    expect(prompt).toMatch(/re-read the board/i);
    expect(prompt).toMatch(/Don't rely on chat history/i);
  });

  it("encodes the AL-16 typed-coordination policy by substring match", () => {
    // Pin the exact marker the role module exports so a future copy edit
    // can't silently drop the typed-coordination guidance — without this
    // assertion, an agent would quietly fall back to free-text handoffs
    // on the channel feed. Mirrors the memory-policy marker test above.
    expect(prompt).toContain(REPO_ADMIN_COORDINATION_POLICY_MARKER);
    // Plus the three typed shapes the prompt names so a partial drop
    // (marker present but shape guidance gone) also trips.
    expect(prompt).toContain("blocked-on-repo");
    expect(prompt).toContain("repo-ready");
    expect(prompt).toContain("merge-order-proposal");
  });

  it("tells repo-admin to propose work instead of reaching for denied tools", () => {
    expect(prompt).toMatch(/propose the work/i);
    expect(prompt).toMatch(/scheduler/i);
  });

  it("lists every allowlisted tool so the agent sees its full surface", () => {
    for (const tool of REPO_ADMIN_ALLOWED_TOOLS) {
      expect(prompt).toContain(`\`${tool}\``);
    }
  });

  it("includes worker-spawn specialty guidance", () => {
    expect(prompt).toMatch(/atlas/);
    expect(prompt).toMatch(/pixel/);
    expect(prompt).toMatch(/forge/);
    expect(prompt).toMatch(/eng-manager/);
  });

  it("name-drops the channel id when provided", () => {
    const withChannel = buildRepoAdminSystemPrompt({
      repoPath: "/tmp/repo",
      channelId: "channel-abc-123",
    });
    expect(withChannel).toContain("channel-abc-123");
  });
});

describe("repo-admin role — built-in tool lockdown (AL-11 B1)", () => {
  it("getDisallowedBuiltinsForRole returns the documented deny list for repo-admin", () => {
    // These are the exact four built-ins the Claude CLI must refuse for a
    // repo-admin session. Order matters for the CLI flag's display, so we
    // pin the array shape directly.
    expect(getDisallowedBuiltinsForRole("repo-admin")).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
  });

  it("returns an empty list for null / unknown roles", () => {
    expect(getDisallowedBuiltinsForRole(null)).toEqual([]);
    expect(getDisallowedBuiltinsForRole("eng-manager")).toEqual([]);
  });
});

describe("role-allowlist — unknown-role hygiene (AL-11 I1)", () => {
  beforeEach(() => {
    __resetUnknownRoleWarningsForTests();
  });

  it("isKnownRole recognises repo-admin and rejects typos / unset roles", () => {
    expect(isKnownRole("repo-admin")).toBe(true);
    expect(isKnownRole("repoadmin")).toBe(false);
    expect(isKnownRole("REPO-ADMIN")).toBe(false);
    expect(isKnownRole(null)).toBe(false);
  });

  it("warns on stderr for unknown roles so typos don't ship as cosmetic enforcement", () => {
    const calls: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // Monkey-patch stderr.write for this test only; restore in finally.
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array
    ) => {
      calls.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      warnIfUnknownRole("repoadmin");
      warnIfUnknownRole("repoadmin"); // second call should be a no-op (memoised)
      warnIfUnknownRole("REPO-ADMIN"); // distinct typo still warns once
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = original;
    }

    // Exactly two writes — one per distinct typo, not one per call.
    expect(calls).toHaveLength(2);
    for (const line of calls) {
      expect(line).toContain("[relay]");
      expect(line).toContain("unknown RELAY_AGENT_ROLE=");
      expect(line).toContain("check spelling");
    }
    expect(calls[0]).toContain("repoadmin");
    expect(calls[1]).toContain("REPO-ADMIN");
  });

  it("does NOT warn for known roles or null", () => {
    const calls: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array
    ) => {
      calls.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      warnIfUnknownRole(null);
      warnIfUnknownRole("repo-admin");
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = original;
    }

    expect(calls).toHaveLength(0);
  });
});

describe("repo-admin role — stubbed tools", () => {
  it("spawn_worker is in the stub registry, pointing at AL-14", () => {
    expect(REPO_ADMIN_TOOL_STUBS.spawn_worker).toMatch(/AL-14/);
  });

  it("spawnWorkerStub throws the registered stub message", () => {
    expect(() => spawnWorkerStub({})).toThrow(/AL-14/);
  });
});
