import { AgentRegistry } from "../agents/registry.js";
import { createLiveAgents, registerAgentNames } from "../agents/factory.js";
import { NodeCommandInvoker } from "../agents/command-invoker.js";
import type { ProviderProfile, ProviderProfileLookup } from "../agents/provider-profile-lookup.js";
import { ProviderProfileStore } from "../storage/provider-profile-store.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import { VerificationRunner } from "../execution/verification-runner.js";
import { ChannelStore } from "../channels/channel-store.js";
import type { Channel } from "../domain/channel.js";
import type { AgentProvider } from "../domain/agent.js";
import { buildWorkspaceId, getWorkspaceDir } from "../cli/workspace-registry.js";
import { OrchestratorV2, buildRunId } from "./orchestrator-v2.js";
import { createPrWatcherFactory } from "../cli/pr-watcher-factory.js";
import { getHarnessStore } from "../storage/factory.js";

export interface DispatchInput {
  featureRequest: string;
  repoPath: string;
  channelId?: string;
  /**
   * Provider-profile lookup override. Defaults to a `ProviderProfileStore`
   * reading `~/.relay/provider-profiles.json`. Tests pass an
   * `InMemoryProviderProfileLookup` so resolution is deterministic.
   */
  providerProfileLookup?: ProviderProfileLookup;
}

/**
 * Resolve which provider profile (if any) should shape this run.
 *
 *   1. `channel.providerProfileId` → fetch that profile.
 *   2. Otherwise the lookup's default profile id → fetch it.
 *   3. Otherwise `null` — `createLiveAgents` falls back to the legacy
 *      `HARNESS_PROVIDER` env path.
 *
 * An explicit id that doesn't resolve returns `null` too: strand the
 * channel on a deleted profile and you'd otherwise get a cryptic spawn
 * failure downstream; letting the run inherit `HARNESS_PROVIDER` is
 * strictly better than silently breaking a chat.
 */
export async function resolveChannelProviderProfile(
  channel: Channel | null,
  lookup: ProviderProfileLookup
): Promise<ProviderProfile | null> {
  if (channel?.providerProfileId) {
    const direct = await lookup.getProfile(channel.providerProfileId);
    if (direct) return direct;
  }
  const defaultId = await lookup.getDefaultProfileId();
  if (defaultId) {
    const fallback = await lookup.getProfile(defaultId);
    if (fallback) return fallback;
  }
  return null;
}

export interface DispatchResult {
  runId: string;
  channelId: string;
  workspaceId: string;
  status: "dispatched";
}

/**
 * Bootstraps a full orchestrator run in the background.
 * Returns immediately with the run ID and channel ID.
 * The orchestrator runs asynchronously — progress is written to
 * the channel feed and artifact store.
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { featureRequest, repoPath } = input;
  const workspaceId = buildWorkspaceId(repoPath);
  const artifactsDir = `${getWorkspaceDir(workspaceId)}/artifacts`;
  const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());
  const channelStore = new ChannelStore(undefined, getHarnessStore());
  const profileLookup: ProviderProfileLookup =
    input.providerProfileLookup ?? new ProviderProfileStore();

  // Resolve or create a channel first — we need its `fullAccess` flag +
  // provider-profile binding to decide how to construct agents.
  //
  // Dedup when no channelId was supplied: an external caller (e.g. an MCP
  // client invoking `harness_dispatch` repeatedly) that submits the same
  // feature request from the same workspace should land on the existing
  // channel instead of minting a new one per call. Match by exact
  // (name, workspaceId, active) — the same triple the original create uses.
  let channelId = input.channelId;
  let channel: Channel | null;
  if (!channelId) {
    const name = featureRequest.slice(0, 60);
    const active = await channelStore.listChannels("active");
    const existing = active.find(
      (c) => c.name === name && (c.workspaceIds ?? []).includes(workspaceId)
    );
    if (existing) {
      channel = existing;
      channelId = existing.channelId;
    } else {
      channel = await channelStore.createChannel({
        name,
        description: featureRequest,
        workspaceIds: [workspaceId],
      });
      channelId = channel.channelId;
    }
  } else {
    channel = await channelStore.getChannel(channelId);
  }
  const channelFullAccess = channel?.fullAccess === true;

  // Resolve the effective provider profile (channel → default → none).
  // When non-null, it overrides the env-driven default provider + supplies
  // an env overlay the CLI subprocess inherits. Null keeps the legacy
  // `HARNESS_PROVIDER` path intact for callers that never configured
  // profiles.
  const profile = await resolveChannelProviderProfile(channel, profileLookup);
  const defaultProvider: AgentProvider =
    profile?.adapter ?? ((process.env.HARNESS_PROVIDER ?? "claude") as AgentProvider);

  await registerAgentNames({ defaultProvider });

  // Build agent registry with the per-channel full-access flag threaded
  // through so Claude gets `--dangerously-skip-permissions` / Codex gets
  // `--sandbox workspace-write --ask-for-approval never` without requiring
  // the machine-wide `RELAY_AUTO_APPROVE`.
  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd: repoPath,
    defaultProvider,
    defaultModel: profile?.defaultModel,
    envOverlay: profile?.envOverrides,
    extraPassEnv: profile?.apiKeyEnvRef ? [profile.apiKeyEnvRef] : undefined,
    fullAccess: channelFullAccess,
  });
  for (const agent of agents) {
    registry.register(agent);
  }

  const verificationRunner = new VerificationRunner(new NodeCommandInvoker(), artifactStore);

  const orchestrator = new OrchestratorV2(
    registry,
    repoPath,
    verificationRunner,
    artifactStore,
    artifactsDir,
    channelStore,
    workspaceId
  );
  // Auto-attach PR watcher. No-op without GITHUB_TOKEN; safe to always call.
  orchestrator.attachPoller(
    createPrWatcherFactory({
      channelStore,
      repoRoot: repoPath,
      defaultChannelId: channelId,
    })
  );

  // Pre-generate run ID so we can return it immediately
  const runId = buildRunId();

  // Link run to channel before starting
  await channelStore.linkRun(channelId, runId, workspaceId);

  // Fire and forget — the orchestrator writes progress to the channel feed
  // and artifact store as it runs. If the top-level run promise rejects we
  // surface the failure to the channel feed so users don't see "dispatched"
  // and then nothing. We only swallow the *return value* (the background task
  // must not throw), never the error itself.
  orchestrator.run(featureRequest, runId).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack =
      error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 20).join("\n") : "";
    channelStore
      .postEntry(channelId!, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Orchestrator",
        content: `Run failed: ${message}`,
        metadata: {
          runId,
          channelId,
          workspaceId,
          error: "true",
          errorMessage: message,
          ...(stack ? { errorStack: stack } : {}),
        },
      })
      .catch((postErr: unknown) => {
        // If posting the failure entry itself fails there is nowhere left to
        // surface it — log to stderr so operators still see the loss.
        const postMessage = postErr instanceof Error ? postErr.message : String(postErr);
        console.warn(
          `[orchestrator] failed to post run-failure entry (runId=${runId} channelId=${channelId}): ${postMessage}`
        );
      });
  });

  return {
    runId,
    channelId,
    workspaceId,
    status: "dispatched",
  };
}
