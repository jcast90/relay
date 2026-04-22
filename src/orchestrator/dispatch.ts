import { AgentRegistry } from "../agents/registry.js";
import { createLiveAgents, registerAgentNames } from "../agents/factory.js";
import { NodeCommandInvoker } from "../agents/command-invoker.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import { VerificationRunner } from "../execution/verification-runner.js";
import { ChannelStore } from "../channels/channel-store.js";
import { buildWorkspaceId, getWorkspaceDir } from "../cli/workspace-registry.js";
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
  const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());
  const channelStore = new ChannelStore(undefined, getHarnessStore());

  // Ensure agents are registered
  const defaultProvider = (process.env.HARNESS_PROVIDER ?? "claude") as "claude" | "codex";
  await registerAgentNames({ defaultProvider });

  // Build agent registry
  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd: repoPath,
    defaultProvider,
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
      workspaceIds: [workspaceId],
    });
    channelId = channel.channelId;
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
