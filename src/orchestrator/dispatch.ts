import { AgentRegistry } from "../agents/registry.js";
import { createLiveAgents, registerAgentNames } from "../agents/factory.js";
import { NodeCommandInvoker } from "../agents/command-invoker.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import { VerificationRunner } from "../execution/verification-runner.js";
import { ChannelStore } from "../channels/channel-store.js";
import {
  buildWorkspaceId,
  getWorkspaceDir
} from "../cli/workspace-registry.js";
import { OrchestratorV2, buildRunId } from "./orchestrator-v2.js";
import { createPrWatcherFactory } from "../cli/pr-watcher-factory.js";
import { getHarnessStore } from "../storage/factory.js";

export interface DispatchInput {
  featureRequest: string;
  repoPath: string;
  channelId?: string;
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
  const artifactStore = new LocalArtifactStore(artifactsDir);
  const channelStore = new ChannelStore(undefined, getHarnessStore());

  // Ensure agents are registered
  const defaultProvider = (process.env.HARNESS_PROVIDER ?? "claude") as "claude" | "codex";
  await registerAgentNames({ defaultProvider });

  // Build agent registry
  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd: repoPath,
    defaultProvider
  });
  for (const agent of agents) {
    registry.register(agent);
  }

  // Resolve or create a channel
  let channelId = input.channelId;
  if (!channelId) {
    const channel = await channelStore.createChannel({
      name: featureRequest.slice(0, 60),
      description: featureRequest,
      workspaceIds: [workspaceId]
    });
    channelId = channel.channelId;
  }

  const verificationRunner = new VerificationRunner(
    new NodeCommandInvoker(),
    artifactStore
  );

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
      defaultChannelId: channelId
    })
  );

  // Pre-generate run ID so we can return it immediately
  const runId = buildRunId();

  // Link run to channel before starting
  await channelStore.linkRun(channelId, runId, workspaceId);

  // Fire and forget — the orchestrator writes progress to the channel feed
  // and artifact store as it runs.
  orchestrator.run(featureRequest, runId)
    .catch((error) => {
      channelStore.postEntry(channelId!, {
        type: "status_update",
        fromAgentId: null,
        fromDisplayName: "Orchestrator",
        content: `Run failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { runId, error: "true" }
      }).catch(() => {});
    });

  return {
    runId,
    channelId,
    workspaceId,
    status: "dispatched"
  };
}
