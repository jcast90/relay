import { describe, expect, it } from "vitest";

import { createLiveAgents } from "../../src/agents/factory.js";
import {
  InMemoryProviderProfileLookup,
  type ProviderProfile,
} from "../../src/agents/provider-profile-lookup.js";
import { resolveChannelProviderProfile } from "../../src/orchestrator/dispatch.js";
import type { Channel } from "../../src/domain/channel.js";
import type { CommandInvocation, CommandInvoker } from "../../src/agents/command-invoker.js";
import type { WorkRequest } from "../../src/domain/agent.js";

function makeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: overrides.id ?? "openrouter",
    displayName: overrides.displayName ?? "OpenRouter",
    adapter: overrides.adapter ?? "codex",
    envOverrides: overrides.envOverrides ?? {
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      HARNESS_AGENT_ATLAS_MODEL: "anthropic/claude-sonnet-4",
    },
    apiKeyEnvRef: overrides.apiKeyEnvRef ?? "OPENROUTER_API_KEY",
    defaultModel: overrides.defaultModel ?? "anthropic/claude-sonnet-4",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: overrides.channelId ?? "channel-1",
    name: overrides.name ?? "#test",
    description: overrides.description ?? "",
    status: overrides.status ?? "active",
    workspaceIds: overrides.workspaceIds ?? [],
    members: overrides.members ?? [],
    pinnedRefs: overrides.pinnedRefs ?? [],
    providerProfileId: overrides.providerProfileId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

describe("resolveChannelProviderProfile (dispatch resolution order)", () => {
  it("prefers channel.providerProfileId over the store default", async () => {
    const channelProfile = makeProfile({ id: "channel-pick" });
    const defaultProfile = makeProfile({ id: "default-pick" });
    const lookup = new InMemoryProviderProfileLookup(
      new Map([
        ["channel-pick", channelProfile],
        ["default-pick", defaultProfile],
      ]),
      "default-pick"
    );

    const resolved = await resolveChannelProviderProfile(
      makeChannel({ providerProfileId: "channel-pick" }),
      lookup
    );

    expect(resolved?.id).toBe("channel-pick");
  });

  it("falls back to the default profile when the channel has no binding", async () => {
    const defaultProfile = makeProfile({ id: "default-pick" });
    const lookup = new InMemoryProviderProfileLookup(
      new Map([["default-pick", defaultProfile]]),
      "default-pick"
    );

    const resolved = await resolveChannelProviderProfile(makeChannel(), lookup);

    expect(resolved?.id).toBe("default-pick");
  });

  it("returns null when neither the channel nor the store binds a profile", async () => {
    const lookup = new InMemoryProviderProfileLookup(new Map(), null);
    const resolved = await resolveChannelProviderProfile(makeChannel(), lookup);
    expect(resolved).toBeNull();
  });

  it("returns null when the channel's id points at a deleted profile and no default exists", async () => {
    const lookup = new InMemoryProviderProfileLookup(new Map(), null);
    const resolved = await resolveChannelProviderProfile(
      makeChannel({ providerProfileId: "ghost" }),
      lookup
    );
    // Degrade gracefully — the legacy HARNESS_PROVIDER path runs instead
    // of crashing a user's chat on a stale id.
    expect(resolved).toBeNull();
  });

  it("treats a null channel as unbound (falls back to default)", async () => {
    const defaultProfile = makeProfile({ id: "default-pick" });
    const lookup = new InMemoryProviderProfileLookup(
      new Map([["default-pick", defaultProfile]]),
      "default-pick"
    );
    const resolved = await resolveChannelProviderProfile(null, lookup);
    expect(resolved?.id).toBe("default-pick");
  });
});

// The next two tests confirm `createLiveAgents` forwards envOverlay and
// extraPassEnv to the invoker. This is the contract dispatch relies on to
// surface a resolved profile to the CLI subprocess.

class CaptureInvoker implements CommandInvoker {
  public lastInvocation: CommandInvocation | null = null;

  constructor(private readonly stdout: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async exec(invocation: CommandInvocation) {
    this.lastInvocation = invocation;
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

describe("createLiveAgents envOverlay + extraPassEnv propagation", () => {
  it("passes the profile's envOverrides into the spawned invocation env", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agents = createLiveAgents({
      cwd: process.cwd(),
      defaultProvider: "claude",
      invoker,
      envOverlay: { ANTHROPIC_BASE_URL: "https://proxy.example.com" },
    });

    await agents[0].run(makeWorkRequest());

    expect(invoker.lastInvocation?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
    });
  });

  it("appends extraPassEnv to the adapter's default allowlist", async () => {
    const invoker = new CaptureInvoker(AGENT_RESULT);
    const agents = createLiveAgents({
      cwd: process.cwd(),
      defaultProvider: "claude",
      invoker,
      extraPassEnv: ["OPENROUTER_API_KEY"],
    });

    await agents[0].run(makeWorkRequest());

    const passEnv = invoker.lastInvocation?.passEnv ?? [];
    expect(passEnv).toContain("OPENROUTER_API_KEY");
    // Still carries the default Claude vars — extraPassEnv is additive.
    expect(passEnv).toContain("ANTHROPIC_API_KEY");
  });
});
