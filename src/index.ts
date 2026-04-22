import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createLiveAgents, registerAgentNames } from "./agents/factory.js";
import { getAgentName } from "./domain/agent-names.js";
import { NodeCommandInvoker } from "./agents/command-invoker.js";
import {
  buildClaudeLaunchArgs,
  buildCodexLaunchArgs,
  ensureClaudeMcpConfig,
  hasHarnessMcpOptOut,
  isAutoApproveEnabled,
  stripAutoApproveFlags,
  stripHarnessMcpOptOut,
} from "./cli/agent-wrapper.js";
import { AgentRegistry } from "./agents/registry.js";
import { launchGui, launchTui, parseGuiFlags } from "./cli/launch-gui-tui.js";
import { parseRebuildFlags, runRebuild } from "./cli/rebuild.js";
import { launchInteractiveCommand } from "./cli/launcher.js";
import { createStreamActivityRenderer, isQuietMode } from "./cli/stream-activity-renderer.js";
import { hasOnboarded, parseWelcomeFlags, runWelcome } from "./cli/welcome.js";
import {
  ensureHarnessWorkspace,
  type HarnessServiceStatus,
  type HarnessWorkspacePaths,
  readWorkspaceSummary,
} from "./cli/workspace.js";
import { getGlobalRoot, listRegisteredWorkspaces } from "./cli/workspace-registry.js";
import { addProjectDir, readConfig, removeProjectDir } from "./cli/config.js";
import { LocalArtifactStore } from "./execution/artifact-store.js";
import { getHarnessStore } from "./storage/factory.js";
import { buildMcpMessageHandler, startMcpServer } from "./mcp/server.js";
import { startHttpMcpServer } from "./mcp/http-transport.js";
import { validateServeOptions } from "./mcp/serve-validation.js";
import { VerificationRunner } from "./execution/verification-runner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { OrchestratorV2 } from "./orchestrator/orchestrator-v2.js";
import { ScriptedInvoker } from "./simulation/scripted-invoker.js";
import { ChannelStore } from "./channels/channel-store.js";
import { resolveBoardTickets } from "./channels/board-resolver.js";
import { createPrWatcherFactory, getActiveWatcher } from "./cli/pr-watcher-factory.js";
import type { HarnessPR } from "./integrations/scm.js";
import { fetchLinearProject, mirrorLinearProject } from "./integrations/linear-mirror.js";
import { handleCrosslinkCommand } from "./crosslink/cli.js";
import { startDashboard } from "./tui/dashboard.js";
import { SessionStore } from "./cli/session-store.js";
import { buildSystemPrompt, resolveChannelRefs, findMcpConfig } from "./cli/chat-context.js";
import { rewindApply, rewindSnapshot } from "./cli/chat-rewind.js";
import { submitApproval } from "./orchestrator/approval-gate.js";
import { getWorkspaceDir } from "./cli/workspace-registry.js";

export async function main(): Promise<void> {
  const cwd = process.cwd();
  const rawCommand = process.argv[2];
  const args = process.argv.slice(3);
  const live = process.env.HARNESS_LIVE === "1";

  // Top-level help / version short-circuit. These run BEFORE workspace
  // bootstrap so `rly --help` / `rly --version` on a fresh machine print
  // cleanly without creating a `~/.relay/` tree or a `.relay/` in cwd.
  if (
    rawCommand === undefined ||
    rawCommand === "--help" ||
    rawCommand === "-h" ||
    rawCommand === "help"
  ) {
    await printTopLevelHelp();
    return;
  }

  if (rawCommand === "--version" || rawCommand === "-v" || rawCommand === "version") {
    const version = await readPackageVersion();
    console.log(`rly v${version}`);
    return;
  }

  const command = rawCommand;
  const packageVersion = await readPackageVersion();
  const workspace = await ensureHarnessWorkspace(cwd, packageVersion);
  const artifactStore = new LocalArtifactStore(workspace.paths.artifactsDir, getHarnessStore());

  if (command === "up") {
    await printUpStatus(workspace);
    return;
  }

  if (command === "status") {
    await printStatus(artifactStore, cwd);
    return;
  }

  if (command === "list-runs") {
    await printRunsIndex(artifactStore, cwd, args);
    return;
  }

  if (command === "list-workspaces" || command === "workspaces") {
    await printWorkspaces(args);
    return;
  }

  if (command === "inspect-mcp") {
    await inspectMcp({
      cwd,
      args,
      workspace,
      artifactStore,
    });
    return;
  }

  if (command === "doctor") {
    await printDoctor({
      cwd,
      args,
      workspace,
      artifactStore,
    });
    return;
  }

  if (command === "config") {
    await handleConfigCommand(args);
    return;
  }

  if (command === "session") {
    await handleSessionCommand(args);
    return;
  }

  if (command === "chat") {
    await handleChatCommand(args, cwd, workspace);
    return;
  }

  if (command === "dashboard") {
    await startDashboard();
    return;
  }

  if (command === "tui") {
    process.exitCode = await launchTui(cwd);
    return;
  }

  if (command === "gui") {
    process.exitCode = await launchGui(parseGuiFlags(args));
    return;
  }

  if (command === "rebuild") {
    process.exitCode = await runRebuild(parseRebuildFlags(args));
    return;
  }

  if (command === "welcome") {
    process.exitCode = await runWelcome(parseWelcomeFlags(args));
    return;
  }

  if (command === "channels") {
    await printChannels(args);
    return;
  }

  if (command === "channel") {
    await handleChannelCommand(args);
    return;
  }

  if (command === "running") {
    await printRunningTasks(args);
    return;
  }

  if (command === "board") {
    await printTaskBoard(args[0] ?? "", args);
    return;
  }

  if (command === "decisions") {
    await printDecisions(args[0] ?? "", args);
    return;
  }

  if (command === "crosslink") {
    await handleCrosslinkCommand(args[0] ?? "status", args.slice(1));
    return;
  }

  if (command === "pr-watch") {
    await handlePrWatchCommand(args);
    return;
  }

  if (command === "pr-status") {
    await handlePrStatusCommand(args);
    return;
  }

  if (command === "approve" || command === "reject") {
    await handlePlanDecisionCommand(command, args, cwd);
    return;
  }

  if (command === "pending-plans") {
    await handlePendingPlansCommand(args, cwd);
    return;
  }

  if (command === "mcp-server") {
    await startMcpServer(resolveWorkspaceRoot(cwd, args));
    return;
  }

  if (command === "serve") {
    await handleServeCommand(cwd, args);
    return;
  }

  if (
    command === "claude" ||
    command === "codex" ||
    command.startsWith("claude-") ||
    command.startsWith("codex-")
  ) {
    // First-run nudge: print a one-liner pointing at `rly welcome` if the
    // user hasn't done the tour. Non-blocking.
    if (!hasOnboarded()) {
      console.log(
        "\x1b[2mTip: `rly welcome` walks through channels, sessions, board, and auto-approve.\x1b[0m"
      );
    }
    const cliEntrypoint = resolveCliEntrypoint();
    const attachHarnessMcp = !hasHarnessMcpOptOut(args);
    const autoApprove = isAutoApproveEnabled(args);
    const userArgs = stripAutoApproveFlags(stripHarnessMcpOptOut(args));

    // For claude-* variants (e.g. claude-myproject), use the base binary
    // with CLAUDE_CONFIG_DIR set to ~/.claude-<variant>
    const isVariant = command.startsWith("claude-") || command.startsWith("codex-");
    const baseBinary = isVariant ? command.split("-")[0] : command;
    const variantEnv: Record<string, string> = {};
    if (isVariant) {
      const variantName = command; // e.g. "claude-myproject"
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      variantEnv.CLAUDE_CONFIG_DIR = `${home}/.${variantName}`;
    }

    const launchArgs = attachHarnessMcp
      ? await buildWrappedAgentLaunchArgs({
          command: baseBinary,
          cwd,
          cliEntrypoint,
          userArgs,
          workspace,
          autoApprove,
        })
      : userArgs;
    const exitCode = await launchInteractiveCommand({
      command: baseBinary,
      args: launchArgs,
      cwd,
      env: {
        ...variantEnv,
        RELAY_HOME: workspace.paths.rootDir,
        RELAY_ARTIFACTS_DIR: workspace.paths.artifactsDir,
        RELAY_RUNS_INDEX: workspace.paths.runsIndexPath,
        // Propagate to children (dispatched agents) so they inherit.
        ...(autoApprove ? { RELAY_AUTO_APPROVE: "1" } : {}),
      },
    });

    process.exitCode = exitCode;
    return;
  }

  // `rly run --autonomous <channelId> ...` (AL-3) is a distinct sub-command:
  // instead of classify-plan-execute on a feature request, it boots an
  // autonomous session against an existing channel's ticket board. Handled
  // here, at the top of the run handler, so the default ("feature request")
  // code path below never sees a channelId as its first positional.
  if (command === "run" && args.includes("--autonomous")) {
    const { handleRunAutonomous } = await import("./cli/run-autonomous.js");
    const result = await handleRunAutonomous(args);
    process.exitCode = result.exitCode;
    return;
  }

  const sequential = args.includes("--sequential");
  const featureRequest = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();

  if (!featureRequest) {
    console.error("Usage: rly run <feature request>");
    console.error('  Example: rly run "Add user authentication with OAuth2"');
    process.exitCode = 1;
    return;
  }

  const defaultProvider = (process.env.HARNESS_PROVIDER ?? "claude") as "claude" | "codex";
  const agentOverrides = parseAgentOverrides();
  await registerAgentNames({ defaultProvider, overrides: agentOverrides });
  const registry = new AgentRegistry();

  // Inline tool-use activity (OSS-06). Active only for live Claude runs where
  // stderr is a TTY and the user hasn't opted out via --quiet / RELAY_QUIET.
  // Scripted runs don't hit the Claude CLI so there's nothing to stream.
  const streamQuiet = isQuietMode(args);
  const streamRendererEnabled = live && !streamQuiet;
  const streamRenderers = new Map<string, ReturnType<typeof createStreamActivityRenderer>>();
  const agents = createLiveAgents({
    cwd,
    invoker: live ? undefined : new ScriptedInvoker(cwd),
    defaultProvider,
    overrides: agentOverrides,
    onStreamLineFor: streamRendererEnabled
      ? (spec) => {
          const renderer = createStreamActivityRenderer({ label: spec.id });
          streamRenderers.set(spec.id, renderer);
          return (line: string) => renderer.onLine(line);
        }
      : undefined,
  });

  for (const agent of agents) {
    registry.register(agent);
  }

  const verificationRunner = new VerificationRunner(new NodeCommandInvoker(), artifactStore);
  let run: Awaited<ReturnType<Orchestrator["run"]>>;

  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    if (sequential) {
      const orchestrator = new Orchestrator(
        registry,
        cwd,
        verificationRunner,
        artifactStore,
        workspace.paths.artifactsDir
      );
      run = await orchestrator.run(featureRequest, runId);
    } else {
      const channelStore = new ChannelStore(undefined, getHarnessStore());
      const orchestratorV2 = new OrchestratorV2(
        registry,
        cwd,
        verificationRunner,
        artifactStore,
        workspace.paths.artifactsDir,
        channelStore,
        workspace.status.workspaceId
      );
      // Auto-attach the PR watcher. Factory is a no-op when GITHUB_TOKEN is
      // missing or the repo isn't a GitHub remote, so this is safe to always
      // call — it never blocks the run.
      orchestratorV2.attachPoller(
        createPrWatcherFactory({
          channelStore,
          repoRoot: cwd,
        })
      );
      run = await orchestratorV2.run(featureRequest, runId);
    }
  } catch (error) {
    // Flush any pending streaming activity before surfacing the failure so
    // the last few tool calls aren't lost when a burst was still in flight.
    for (const r of streamRenderers.values()) r.flush();
    console.error("Orchestrator failed:", error instanceof Error ? error.message : error);

    // Mark the run as FAILED in the index so the dashboard doesn't show it as active
    const now = new Date().toISOString();
    await artifactStore.saveRunsIndex({
      entry: {
        runId,
        featureRequest,
        state: "FAILED",
        channelId: null,
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        phaseLedgerPath: null,
        artifactsRoot: `${workspace.paths.artifactsDir}/${runId}`,
      },
    });

    process.exitCode = 1;
    return;
  }
  for (const r of streamRenderers.values()) r.flush();
  const recentRuns = await artifactStore.readRunsIndex();

  console.log(`Run id: ${run.id}`);
  console.log(`Run state: ${run.state}`);
  console.log(`Classification: ${run.classification?.tier ?? "none"}`);
  console.log("");
  console.log(`Execution mode: ${live ? "live CLI agents" : "scripted simulation"}`);
  console.log(`Orchestrator: ${sequential ? "sequential (v1)" : "ticket-based (v2)"}`);
  console.log("");
  console.log("Planned phases:");

  for (const phase of run.plan?.phases ?? []) {
    console.log(`- ${phase.id}: ${phase.title} [${phase.specialty}]`);
  }

  console.log("");
  console.log("Evidence:");

  for (const item of run.evidence) {
    const name = await getAgentName(item.agentId);
    console.log(`- [${name}] ${item.phaseId} attempt=${item.attempt} ${item.summary}`);
  }

  console.log("");
  console.log("Phase ledger:");

  for (const entry of run.phaseLedger) {
    const classification = entry.lastClassification
      ? `${entry.lastClassification.category}`
      : "none";
    console.log(
      `- ${entry.phaseId} lifecycle=${entry.lifecycle} verification=${entry.verification} classification=${classification} next=${JSON.stringify(entry.chosenNextAction)}`
    );
  }

  if (run.ticketLedger.length > 0) {
    console.log("");
    console.log("Ticket ledger:");

    for (const entry of run.ticketLedger) {
      const agent = entry.assignedAgentName ?? "unassigned";
      console.log(
        `- ${entry.ticketId} [${agent}] status=${entry.status} verification=${entry.verification} deps=[${entry.dependsOn.join(",")}]`
      );
    }
  }

  console.log("");
  console.log(`Phase ledger path: ${run.phaseLedgerPath ?? "(not written)"}`);
  console.log(`Ticket ledger path: ${run.ticketLedgerPath ?? "(not written)"}`);
  console.log(`Runs index path: ${run.runIndexPath ?? "(not written)"}`);

  console.log("");
  console.log("Artifacts:");

  for (const artifact of run.artifacts) {
    if (artifact.type === "command_result") {
      console.log(
        `- ${artifact.phaseId} ${artifact.command} exit=${artifact.exitCode} path=${artifact.path}`
      );
      continue;
    }

    console.log(
      `- ${artifact.phaseId} classification=${artifact.category} action=${JSON.stringify(artifact.nextAction)} path=${artifact.path}`
    );
  }

  console.log("");
  console.log("Failure decisions:");

  const classificationArtifacts = run.artifacts.filter(
    (artifact) => artifact.type === "failure_classification"
  );

  if (classificationArtifacts.length === 0) {
    console.log("- None captured");
  } else {
    for (const artifact of classificationArtifacts) {
      console.log(
        `- ${artifact.phaseId} ${artifact.category}: ${artifact.rationale} Next: ${artifact.nextAction}`
      );
    }
  }

  console.log("");
  console.log("Recent runs:");

  for (const entry of recentRuns.slice(0, 5)) {
    console.log(
      `- ${entry.runId} state=${entry.state} ledger=${entry.phaseLedgerPath ?? "(missing)"} artifacts=${entry.artifactsRoot}`
    );
  }

  console.log("");
  console.log("Event trail:");

  for (const event of run.events) {
    console.log(
      `- ${event.createdAt} ${event.phaseId} ${event.type} ${JSON.stringify(event.details)}`
    );
  }
}

// `getHarnessStore` is re-exported from the factory so legacy call sites can
// continue to import it from this module.
export { getHarnessStore };

async function printChannels(args: string[] = []): Promise<void> {
  if (args.includes("--json")) {
    const store = new ChannelStore(undefined, getHarnessStore());
    const channels = await store.listChannels("active");
    jsonOut(channels);
    return;
  }
  const store = new ChannelStore(undefined, getHarnessStore());
  const channels = await store.listChannels();

  if (channels.length === 0) {
    console.log("No channels. Create one with: rly channel create <name>");
    return;
  }

  console.log(`Channels (${channels.length}):`);

  for (const ch of channels) {
    const activeMembers = ch.members.filter((m) => m.status === "active").length;
    console.log(`  ${ch.name} (${ch.channelId})`);
    console.log(`    ${ch.description}`);
    console.log(
      `    Status: ${ch.status} | Members: ${activeMembers}/${ch.members.length} | Refs: ${ch.pinnedRefs.length}`
    );
    console.log("");
  }
}

async function handleChannelCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const store = new ChannelStore(undefined, getHarnessStore());

  if (sub === "create") {
    const name = args[1];
    if (!name) {
      console.error(
        "Usage: rly channel create <name> [description] [--repos alias:wsId:path,...] [--primary <alias>]"
      );
      process.exitCode = 1;
      return;
    }

    const reposArg = parseNamedArg(args, "--repos");
    const primaryArg = parseNamedArg(args, "--primary");
    const repoAssignments = reposArg
      ? reposArg.split(",").map((r) => {
          const [alias, workspaceId, ...pathParts] = r.split(":");
          return { alias, workspaceId, repoPath: pathParts.join(":") };
        })
      : undefined;

    let primaryWorkspaceId: string | undefined;
    if (primaryArg) {
      if (!repoAssignments || repoAssignments.length === 0) {
        console.error(`--primary ${primaryArg} requires --repos with at least one entry.`);
        process.exitCode = 1;
        return;
      }
      const match = repoAssignments.find((r) => r.alias === primaryArg);
      if (!match) {
        const known = repoAssignments.map((r) => r.alias).join(", ");
        console.error(
          `--primary alias "${primaryArg}" is not in --repos (known aliases: ${known}).`
        );
        process.exitCode = 1;
        return;
      }
      primaryWorkspaceId = match.workspaceId;
    }

    // Description is everything after name that isn't a flag value.
    const descParts = args
      .slice(2)
      .filter((a) => !a.startsWith("--") && a !== reposArg && a !== primaryArg);
    const description = descParts.join(" ") || `Channel for ${name}`;

    const channel = await store.createChannel({
      name,
      description,
      repoAssignments,
      primaryWorkspaceId,
    });

    if (args.includes("--json")) {
      jsonOut(channel);
    } else {
      console.log(`Channel created: ${channel.name} (${channel.channelId})`);
    }
    return;
  }

  if (sub === "archive") {
    const channelId = args[1];
    if (!channelId) {
      console.error("Usage: rly channel archive <channelId>");
      process.exitCode = 1;
      return;
    }

    const archived = await store.archiveChannel(channelId);

    if (args.includes("--json")) {
      jsonOut(archived);
    } else if (archived) {
      console.log(`Channel archived: ${archived.name} (${archived.channelId})`);
    } else {
      console.error(`Channel not found: ${channelId}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "unarchive") {
    const channelId = args[1];
    if (!channelId) {
      console.error("Usage: rly channel unarchive <channelId>");
      process.exitCode = 1;
      return;
    }

    const unarchived = await store.unarchiveChannel(channelId);

    if (args.includes("--json")) {
      jsonOut(unarchived);
    } else if (unarchived) {
      console.log(`Channel unarchived: ${unarchived.name} (${unarchived.channelId})`);
    } else {
      console.error(`Channel not found: ${channelId}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "set-full-access") {
    const channelId = args[1];
    const stateArg = args[2];
    if (!channelId || !stateArg) {
      console.error("Usage: rly channel set-full-access <channelId> <on|off>");
      process.exitCode = 1;
      return;
    }

    // Accept the few obvious spellings so callers don't have to guess.
    // Anything else is an error — silent coercion of "maybe" to "off" would
    // be a footgun for a flag that disables permission prompts.
    let next: boolean;
    if (stateArg === "on" || stateArg === "true" || stateArg === "1") {
      next = true;
    } else if (stateArg === "off" || stateArg === "false" || stateArg === "0") {
      next = false;
    } else {
      console.error(`set-full-access: expected "on" or "off", got "${stateArg}".`);
      process.exitCode = 1;
      return;
    }

    const sourceArg = parseNamedArg(args, "--source");
    const actorName = parseNamedArg(args, "--actor");
    const actor = {
      source: sourceArg ?? "cli",
      name: actorName ?? "CLI",
      id: actorName ?? "cli",
    };

    const updated = await store.setFullAccess(channelId, next, actor);

    if (args.includes("--json")) {
      jsonOut(updated);
    } else if (updated) {
      console.log(
        `Channel full-access ${updated.fullAccess ? "on" : "off"}: ${updated.name} (${
          updated.channelId
        })`
      );
    } else {
      console.error(`Channel not found: ${channelId}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "update") {
    const channelId = args[1];
    if (!channelId) {
      console.error(
        "Usage: rly channel update <channelId> [--repos alias:wsId:path,...] [--primary <alias>]"
      );
      process.exitCode = 1;
      return;
    }

    const reposArg = parseNamedArg(args, "--repos");
    const primaryArg = parseNamedArg(args, "--primary");
    const patch: Partial<
      Pick<import("./domain/channel.js").Channel, "repoAssignments" | "primaryWorkspaceId">
    > = {};

    if (reposArg) {
      patch.repoAssignments = reposArg.split(",").map((r) => {
        const [alias, workspaceId, ...pathParts] = r.split(":");
        return { alias, workspaceId, repoPath: pathParts.join(":") };
      });
    }

    if (primaryArg) {
      // Resolve --primary against the assignments that will be on the
      // channel after this update: the patched repos (if provided) take
      // precedence over what's currently on disk.
      const existing = await store.getChannel(channelId);
      if (!existing) {
        console.error(`Channel not found: ${channelId}`);
        process.exitCode = 1;
        return;
      }
      const effectiveAssignments = patch.repoAssignments ?? existing.repoAssignments ?? [];
      const match = effectiveAssignments.find((r) => r.alias === primaryArg);
      if (!match) {
        const known = effectiveAssignments.map((r) => r.alias).join(", ") || "(none)";
        console.error(
          `--primary alias "${primaryArg}" is not in the channel's repos (known aliases: ${known}).`
        );
        process.exitCode = 1;
        return;
      }
      patch.primaryWorkspaceId = match.workspaceId;
    }

    const updated = await store.updateChannel(channelId, patch);

    if (args.includes("--json")) {
      jsonOut(updated);
    } else if (updated) {
      console.log(`Channel updated: ${updated.name} (${updated.channelId})`);
    } else {
      console.error(`Channel not found: ${channelId}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "link-linear") {
    await handleChannelLinkLinear(store, args);
    return;
  }

  if (sub === "linear-sync") {
    await handleChannelLinearSync(store, args);
    return;
  }

  if (sub === "feed") {
    const channelId = args[1];
    const limit = Number(parseNamedArg(args, "--limit") ?? "50");

    if (!channelId) {
      console.error("Usage: rly channel feed <channelId> [--limit N]");
      process.exitCode = 1;
      return;
    }

    const feed = await store.readFeed(channelId, limit);

    if (args.includes("--json")) {
      jsonOut(feed);
    } else {
      if (feed.length === 0) {
        console.log("No feed entries.");
      } else {
        for (const entry of feed) {
          const from = entry.fromDisplayName ?? "system";
          console.log(`  [${entry.type}] ${from}: ${entry.content.slice(0, 120)}`);
        }
      }
    }
    return;
  }

  if (sub === "post") {
    const channelId = args[1];
    const content = args
      .slice(2)
      .filter((a) => !a.startsWith("--"))
      .join(" ");
    const fromName = parseNamedArg(args, "--from") ?? "CLI";
    const entryType = parseNamedArg(args, "--type") ?? "message";

    if (!channelId || !content) {
      console.error(
        "Usage: rly channel post <channelId> <content> [--from <name>] [--type <type>]"
      );
      process.exitCode = 1;
      return;
    }

    const entry = await store.postEntry(channelId, {
      type: entryType as "message",
      fromAgentId: null,
      fromDisplayName: fromName,
      content,
      metadata: {},
    });

    jsonOut(entry);
    return;
  }

  if (!sub) {
    console.error(
      "Usage: rly channel <channelId|create|archive|unarchive|set-full-access|update|feed|post>"
    );
    process.exitCode = 1;
    return;
  }

  const channel = await store.getChannel(sub);
  if (!channel) {
    console.error(`Channel not found: ${sub}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${channel.name} (${channel.channelId})`);
  console.log(`  ${channel.description}`);
  console.log(`  Status: ${channel.status}`);
  console.log("");

  if (channel.members.length > 0) {
    console.log("Members:");
    for (const m of channel.members) {
      console.log(`  ${m.displayName} [${m.role}/${m.provider}] — ${m.status}`);
    }
    console.log("");
  }

  if (channel.pinnedRefs.length > 0) {
    console.log("Pinned refs:");
    for (const ref of channel.pinnedRefs) {
      console.log(`  ${ref.label} (${ref.type}: ${ref.targetId})`);
    }
    console.log("");
  }

  const feed = await store.readFeed(sub, 10);
  if (feed.length > 0) {
    console.log("Recent feed:");
    for (const entry of feed) {
      const from = entry.fromDisplayName ?? "system";
      console.log(`  [${entry.type}] ${from}: ${entry.content.slice(0, 120)}`);
    }
  }
}

function getLinearApiKey(): string | null {
  return process.env.LINEAR_API_KEY ?? null;
}

async function handleChannelLinkLinear(store: ChannelStore, args: string[]): Promise<void> {
  const channelId = args[1];
  const projectId = args[2];
  if (!channelId || !projectId) {
    console.error("Usage: rly channel link-linear <channelId> <linearProjectId>");
    process.exitCode = 1;
    return;
  }

  const apiKey = getLinearApiKey();
  if (!apiKey) {
    console.error("LINEAR_API_KEY is not set. Add it to ~/.relay/config.env and re-source.");
    process.exitCode = 1;
    return;
  }

  const channel = await store.getChannel(channelId);
  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exitCode = 1;
    return;
  }

  let project;
  try {
    project = await fetchLinearProject(projectId, { apiKey });
  } catch (err) {
    console.error(
      `Failed to validate Linear project: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
    return;
  }
  if (!project) {
    console.error(`Linear project not found: ${projectId}`);
    process.exitCode = 1;
    return;
  }

  await store.updateChannel(channelId, { linearProjectId: project.id });

  const result = await mirrorLinearProject(channelId, project.id, {
    store,
    apiKey,
  });

  await store.postEntry(channelId, {
    type: "event",
    fromAgentId: null,
    fromDisplayName: "system",
    content: `Linked Linear project "${project.name}" — mirrored ${result.fetched} issue${result.fetched === 1 ? "" : "s"} onto the channel board.`,
    metadata: {
      linearProjectId: project.id,
      linearProjectName: project.name,
      fetched: result.fetched,
    },
  });

  if (args.includes("--json")) {
    jsonOut({
      channelId,
      linearProjectId: project.id,
      linearProjectName: project.name,
      fetched: result.fetched,
      mirrored: result.mirrored.length,
    });
  } else {
    console.log(`Linked "${project.name}" (${project.id}) — mirrored ${result.fetched} issues.`);
  }
}

async function handleChannelLinearSync(store: ChannelStore, args: string[]): Promise<void> {
  const channelId = args[1];
  if (!channelId) {
    console.error("Usage: rly channel linear-sync <channelId>");
    process.exitCode = 1;
    return;
  }

  const apiKey = getLinearApiKey();
  if (!apiKey) {
    console.error("LINEAR_API_KEY is not set.");
    process.exitCode = 1;
    return;
  }

  const channel = await store.getChannel(channelId);
  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exitCode = 1;
    return;
  }
  if (!channel.linearProjectId) {
    console.error(
      `Channel ${channelId} has no Linear project linked. Run: rly channel link-linear ${channelId} <linearProjectId>`
    );
    process.exitCode = 1;
    return;
  }

  const result = await mirrorLinearProject(channelId, channel.linearProjectId, {
    store,
    apiKey,
  });

  if (args.includes("--json")) {
    jsonOut({
      channelId,
      linearProjectId: channel.linearProjectId,
      fetched: result.fetched,
      mirrored: result.mirrored.length,
    });
  } else {
    console.log(
      `Synced Linear project ${channel.linearProjectId} — mirrored ${result.fetched} issues.`
    );
  }
}

/**
 * `rly pr-watch <pr-url-or-number>` — track a PR explicitly.
 * Requires an active watcher built by a running orchestrator; the CLI itself
 * doesn't hold a long-lived process, so in practice this command is most
 * useful inside the `dashboard` / TUI subprocess or when embedded via MCP.
 */
async function handlePrWatchCommand(args: string[]): Promise<void> {
  const input = args[0];
  const ticketId = parseNamedArg(args, "--ticket") ?? `manual-${Date.now()}`;
  const channelId = parseNamedArg(args, "--channel");
  const branchHint = parseNamedArg(args, "--branch");

  if (!input) {
    console.error(
      "Usage: rly pr-watch <pr-url-or-number> [--ticket <id>] [--channel <id>] [--branch <branch>]"
    );
    process.exitCode = 1;
    return;
  }

  const watcher = getActiveWatcher();
  if (!watcher) {
    console.error(
      "No active PR watcher. A watcher only exists while an orchestrator run is in progress and GITHUB_TOKEN is set."
    );
    process.exitCode = 1;
    return;
  }

  const resolvedChannelId = channelId ?? (await resolveDefaultChannelId());
  if (!resolvedChannelId) {
    console.error("No channel to associate with — pass --channel <id>.");
    process.exitCode = 1;
    return;
  }

  const pr = await resolvePrFromInput(input, watcher.repo, watcher.scm, branchHint);
  if (!pr) {
    console.error(
      `Could not resolve PR from "${input}". Provide a full GitHub URL or a PR number.`
    );
    process.exitCode = 1;
    return;
  }

  if (!pr.branch && branchHint) {
    // Explicit branch flag wins over synthesised empty — surfaces in follow-up
    // prompts that interpolate entry.pr.branch into git push instructions.
    pr.branch = branchHint;
  } else if (!pr.branch) {
    console.warn(
      "[pr-watch] tracking with empty branch — CI/review transitions will surface, " +
        "but fix-ci / address-reviews follow-up prompts will lack a branch for git push. " +
        "Pass --branch <branch> to populate it."
    );
  }

  watcher.track({
    ticketId,
    channelId: resolvedChannelId,
    pr,
    repo: watcher.repo,
  });

  console.log(
    `Tracking ${watcher.repo.owner}/${watcher.repo.name}#${pr.number} (ticket: ${ticketId})`
  );
}

/**
 * `rly pr-status` — table of currently tracked PRs. When an orchestrator is
 * running in this process, read the live watcher; otherwise fall back to the
 * persisted snapshot the watcher mirrors to `channels/<id>/tracked-prs.json`
 * so the TUI and GUI (which are separate processes) see the same rows.
 * A trailing `--channel <id>` narrows the readback; absent, we aggregate
 * every channel.
 */
async function handlePrStatusCommand(args: string[] = []): Promise<void> {
  const watcher = getActiveWatcher();
  const channelFilter = parseNamedArg(args, "--channel");

  type Row = {
    ticketId: string;
    owner: string;
    name: string;
    number: number;
    branch: string;
    ci: string | null;
    review: string | null;
    prState: string | null;
  };

  let rows: Row[] = [];

  if (watcher) {
    rows = watcher
      .listTracked()
      .filter((t) => !channelFilter || t.channelId === channelFilter)
      .map((t) => ({
        ticketId: t.ticketId,
        owner: t.repo.owner,
        name: t.repo.name,
        number: t.pr.number,
        branch: t.pr.branch,
        ci: t.last?.ci ?? null,
        review: t.last?.review ?? null,
        prState: t.last?.prState ?? null,
      }));
  } else {
    const channelStore = new ChannelStore(undefined, getHarnessStore());
    const channelIds = channelFilter
      ? [channelFilter]
      : (await channelStore.listChannels()).map((c) => c.channelId);
    for (const cid of channelIds) {
      const persisted = await channelStore.readTrackedPrs(cid);
      for (const p of persisted) {
        rows.push({
          ticketId: p.ticketId,
          owner: p.owner,
          name: p.name,
          number: p.number,
          branch: p.branch,
          ci: p.ci,
          review: p.review,
          prState: p.prState,
        });
      }
    }
  }

  if (args.includes("--json")) {
    jsonOut(rows);
    return;
  }

  if (rows.length === 0) {
    console.log(
      watcher
        ? "No PRs currently tracked."
        : "No tracked PRs on disk (no recent orchestrator run, or GITHUB_TOKEN was unset)."
    );
    return;
  }

  console.log(`Tracked PRs (${rows.length}):`);
  console.log(
    "  TICKET             PR                                   STATE     CI        REVIEW"
  );

  for (const t of rows) {
    const label = `${t.owner}/${t.name}#${t.number}`;
    const state = t.prState ?? "-";
    const ci = t.ci ?? "-";
    const review = t.review ?? "-";
    console.log(
      `  ${t.ticketId.padEnd(18)} ${label.padEnd(36)} ${state.padEnd(9)} ${ci.padEnd(9)} ${review}`
    );
  }
}

/**
 * `rly approve <runId>` / `rly reject <runId> [--feedback "text"]` — CLI
 * parity for the `harness_approve_plan` / `harness_reject_plan` MCP tools.
 * The TUI and GUI shell out here so there's exactly one place where an
 * approval record is written (via `submitApproval` → artifact store). We
 * discover which workspace owns the run by scanning the workspace-registry
 * for one whose artifacts dir contains `<runId>__approval` territory; the
 * `LocalArtifactStore` is then pointed at that workspace's artifacts dir.
 */
async function handlePlanDecisionCommand(
  command: "approve" | "reject",
  args: string[],
  _cwd: string
): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const runId = positionals[0];
  const feedback = parseNamedArg(args, "--feedback") ?? undefined;

  if (!runId) {
    console.error(`Usage: rly ${command} <runId> [--feedback "text"]`);
    process.exitCode = 1;
    return;
  }

  const workspaceId = await resolveWorkspaceIdForRun(runId);
  if (!workspaceId) {
    console.error(
      `Could not locate workspace containing run ${runId}. Run \`rly list-runs\` from the workspace that owns the run.`
    );
    process.exitCode = 1;
    return;
  }
  const artifactsDir = `${getWorkspaceDir(workspaceId)}/artifacts`;
  const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());
  const decision = command === "approve" ? "approved" : "rejected";

  try {
    const path = await submitApproval({
      runId,
      decision,
      feedback,
      artifactStore,
    });
    jsonOut({ ok: true, runId, decision, feedback, workspaceId, path });
  } catch (err) {
    console.error(
      `Failed to ${command} run ${runId}: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}

/**
 * `rly pending-plans [--json]` — list runs awaiting approval across every
 * registered workspace. The TUI and GUI poll this to know when to show the
 * plan-approval banner / CTA. A run is "pending" when its `state` is
 * `AWAITING_APPROVAL` and no approval record has been written yet.
 */
async function handlePendingPlansCommand(args: string[], _cwd: string): Promise<void> {
  const workspaces = await listRegisteredWorkspaces();
  const pending: Array<{
    runId: string;
    workspaceId: string;
    featureRequest: string;
    channelId: string | null;
    state: string;
    updatedAt: string;
  }> = [];
  for (const ws of workspaces) {
    const artifactsDir = `${getWorkspaceDir(ws.workspaceId)}/artifacts`;
    const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());
    const runs = await artifactStore.readRunsIndex();
    for (const r of runs) {
      if (r.state !== "AWAITING_APPROVAL") continue;
      const existing = await artifactStore.readApprovalRecord(r.runId);
      if (existing) continue; // already decided, orchestrator just hasn't advanced yet
      pending.push({
        runId: r.runId,
        workspaceId: ws.workspaceId,
        featureRequest: r.featureRequest,
        channelId: r.channelId,
        state: r.state,
        updatedAt: r.updatedAt,
      });
    }
  }

  if (args.includes("--json")) {
    jsonOut(pending);
    return;
  }

  if (pending.length === 0) {
    console.log("No runs awaiting approval.");
    return;
  }

  console.log(`Runs awaiting approval (${pending.length}):`);
  for (const p of pending) {
    const channel = p.channelId ? ` channel=${p.channelId}` : "";
    console.log(
      `  ${p.runId}  workspace=${p.workspaceId}${channel}  "${p.featureRequest.slice(0, 60)}"`
    );
  }
  console.log("\nApprove with: rly approve <runId>");
  console.log('Reject with:  rly reject <runId> [--feedback "…"]');
}

async function resolveWorkspaceIdForRun(runId: string): Promise<string | null> {
  const workspaces = await listRegisteredWorkspaces();
  for (const ws of workspaces) {
    const artifactsDir = `${getWorkspaceDir(ws.workspaceId)}/artifacts`;
    const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());
    const runs = await artifactStore.readRunsIndex();
    if (runs.some((r) => r.runId === runId)) return ws.workspaceId;
  }
  return null;
}

/**
 * Resolve a PR reference into a `HarnessPR`.
 *
 * - `https://github.com/owner/name/pull/123` URLs and bare `123` / `#123`
 *   numbers both work.
 * - If a `branchHint` is supplied, we first try `scm.detectPR(branchHint, repo)`
 *   so we can fill in the actual branch (used by fix-ci / address-reviews
 *   follow-up prompts that interpolate `pr.branch` into git push commands).
 * - When we can't learn the branch, we synthesise a `HarnessPR` with an empty
 *   branch. Empty-branch tracking still surfaces CI/review transitions via
 *   `enrichBatch`, which is what the poller consumes.
 */
async function resolvePrFromInput(
  input: string,
  repo: { owner: string; name: string },
  scm: {
    detectPR: (branch: string, repo: { owner: string; name: string }) => Promise<HarnessPR | null>;
  },
  branchHint?: string
): Promise<HarnessPR | null> {
  const trimmed = input.trim();

  if (branchHint) {
    try {
      const viaBranch = await scm.detectPR(branchHint, repo);
      if (viaBranch) return viaBranch;
    } catch {
      // Fall through to URL/number parsing. A transient SCM failure shouldn't
      // block manual tracking.
    }
  }

  // https://github.com/owner/name/pull/123
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/pull\/(\d+)(?:[/?#].*)?$/i
  );
  if (urlMatch) {
    const number = Number(urlMatch[3]);
    return {
      number,
      url: `https://github.com/${urlMatch[1]}/${urlMatch[2]}/pull/${number}`,
      branch: branchHint ?? "",
    };
  }

  const numMatch = trimmed.match(/^#?(\d+)$/);
  if (numMatch) {
    const number = Number(numMatch[1]);
    return {
      number,
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
      branch: branchHint ?? "",
    };
  }

  return null;
}

/**
 * Find a channel to attach the tracked PR to. Prefers the most recently
 * updated active channel — this covers the common case of one CLI user with
 * one in-flight run. Returns null when no channels exist.
 */
async function resolveDefaultChannelId(): Promise<string | null> {
  const store = new ChannelStore(undefined, getHarnessStore());
  const channels = await store.listChannels("active");
  return channels[0]?.channelId ?? null;
}

async function printRunningTasks(args: string[] = []): Promise<void> {
  const workspaces = await listRegisteredWorkspaces();
  const activeStates = new Set([
    "CLASSIFYING",
    "DRAFT_PLAN",
    "PLAN_REVIEW",
    "AWAITING_APPROVAL",
    "DESIGN_DOC",
    "PHASE_READY",
    "PHASE_EXECUTE",
    "TEST_FIX_LOOP",
    "REVIEW_FIX_LOOP",
    "TICKETS_EXECUTING",
    "TICKETS_COMPLETE",
  ]);

  const activeRuns: Array<{
    runId: string;
    state: string;
    featureRequest: string;
    workspace: string;
    channelId: string | null;
  }> = [];

  for (const ws of workspaces) {
    const wsArtifactStore = new LocalArtifactStore(
      `${getGlobalRoot()}/workspaces/${ws.workspaceId}/artifacts`,
      getHarnessStore()
    );
    const runs = await wsArtifactStore.readRunsIndex();

    for (const run of runs) {
      if (activeStates.has(run.state) && !run.completedAt) {
        activeRuns.push({
          runId: run.runId,
          state: run.state,
          featureRequest: run.featureRequest,
          workspace: ws.repoPath,
          channelId: run.channelId ?? null,
        });
      }
    }
  }

  if (args.includes("--json")) {
    jsonOut(activeRuns);
    return;
  }

  if (activeRuns.length === 0) {
    console.log("No running tasks.");
  } else {
    for (const run of activeRuns) {
      console.log(`  ${run.runId} [${run.state}] ${run.featureRequest.slice(0, 80)}`);
      console.log(`    Workspace: ${run.workspace}`);
      if (run.channelId) console.log(`    Channel: ${run.channelId}`);
      console.log("");
    }
    console.log(`${activeRuns.length} active task(s).`);
  }
}

async function printTaskBoard(channelId: string, args: string[] = []): Promise<void> {
  if (!channelId) {
    console.error("Usage: rly board <channelId>");
    process.exitCode = 1;
    return;
  }

  const store = new ChannelStore(undefined, getHarnessStore());
  const channel = await store.getChannel(channelId);

  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exitCode = 1;
    return;
  }

  // Delegates to resolveBoardTickets so CLI + MCP tool + GUI all read the
  // channel board through the same unified-then-fallback policy.
  interface BoardRow {
    ticketId: string;
    title: string;
    source?: "relay" | "linear";
    linearIdentifier?: string;
    linearUrl?: string;
  }
  const board: Record<string, BoardRow[]> = {};
  const resolved = await resolveBoardTickets(store, channelId, async (workspaceId, runId) => {
    const wsStore = new LocalArtifactStore(
      `${getGlobalRoot()}/workspaces/${workspaceId}/artifacts`,
      getHarnessStore()
    );
    return wsStore.readTicketLedger(runId);
  });

  for (const { entry } of resolved) {
    if (!board[entry.status]) board[entry.status] = [];
    board[entry.status].push({
      ticketId: entry.ticketId,
      title: entry.title,
      source: entry.source,
      linearIdentifier: entry.linearIdentifier,
      linearUrl: entry.linearUrl,
    });
  }

  if (args.includes("--json")) {
    jsonOut(board);
    return;
  }

  if (Object.keys(board).length === 0) {
    console.log("No tickets on this channel.");
    return;
  }

  for (const [status, tickets] of Object.entries(board)) {
    console.log(`[${status.toUpperCase()}] (${tickets.length})`);
    for (const t of tickets) {
      if (t.source === "linear" && t.linearIdentifier) {
        const tail = t.linearUrl ? `  ${t.linearUrl}` : "";
        console.log(`  [linear ${t.linearIdentifier}] ${t.title}${tail}`);
      } else {
        console.log(`  ${t.ticketId}: ${t.title}`);
      }
    }
    console.log("");
  }
}

async function printDecisions(channelId: string, args: string[] = []): Promise<void> {
  if (!channelId) {
    console.error("Usage: rly decisions <channelId>");
    process.exitCode = 1;
    return;
  }

  const store = new ChannelStore(undefined, getHarnessStore());
  const channel = await store.getChannel(channelId);

  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exitCode = 1;
    return;
  }

  const decisions = await store.listDecisions(channelId);

  if (args.includes("--json")) {
    jsonOut(decisions);
    return;
  }

  if (decisions.length === 0) {
    console.log("No decisions recorded in this channel.");
    return;
  }

  for (const d of decisions) {
    console.log(`${d.decisionId}: ${d.title}`);
    console.log(`  By: ${d.decidedByName}`);
    console.log(`  Rationale: ${d.rationale}`);
    if (d.alternatives.length > 0) {
      console.log(`  Alternatives: ${d.alternatives.join(", ")}`);
    }
    console.log(`  Decided: ${d.createdAt}`);
    console.log("");
  }
}

async function printWorkspaces(args: string[] = []): Promise<void> {
  const globalRoot = getGlobalRoot();
  const workspaces = await listRegisteredWorkspaces();

  if (args.includes("--json")) {
    jsonOut(workspaces);
    return;
  }

  console.log(`Global root: ${globalRoot}`);
  console.log("");

  if (workspaces.length === 0) {
    console.log("No workspaces registered. Run `rly up` in a repo to register it.");
    return;
  }

  console.log(`Registered workspaces (${workspaces.length}):`);

  for (const ws of workspaces) {
    console.log(`  ${ws.workspaceId}`);
    console.log(`    Repo: ${ws.repoPath}`);
    console.log(`    Registered: ${ws.registeredAt}`);
    console.log(`    Last accessed: ${ws.lastAccessedAt}`);
    console.log("");
  }
}

async function handleConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "add-project-dir") {
    const dir = args[1];
    if (!dir) {
      console.error("Usage: rly config add-project-dir <path>");
      process.exitCode = 1;
      return;
    }
    const config = await addProjectDir(dir);
    console.log(`Added project directory: ${dir}`);
    console.log(`Project directories: ${config.projectDirs.join(", ")}`);
    return;
  }

  if (subcommand === "remove-project-dir") {
    const dir = args[1];
    if (!dir) {
      console.error("Usage: rly config remove-project-dir <path>");
      process.exitCode = 1;
      return;
    }
    const config = await removeProjectDir(dir);
    console.log(`Removed project directory: ${dir}`);
    console.log(`Project directories: ${config.projectDirs.join(", ")}`);
    return;
  }

  // Default: show current config
  const config = await readConfig();
  console.log("Global config:");
  console.log(`  Config path: ${getGlobalRoot()}/config.json`);
  console.log("");
  if (config.projectDirs.length === 0) {
    console.log("  Project directories: (none)");
    console.log("");
    console.log("  Add directories with: rly config add-project-dir ~/projects");
  } else {
    console.log("  Project directories:");
    for (const dir of config.projectDirs) {
      console.log(`    - ${dir}`);
    }
  }
}

function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function parseNamedArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Extract positional arguments: strip `--flag` entries AND the values that
 * follow them, unless the next entry is itself a flag (boolean flag case).
 * Replaces the naive `args.filter(a => !a.startsWith("--"))` pattern, which
 * leaked flag values (channel ids, session ids, role) into content fields —
 * visible in chat history as "ch-... sess-... user <message>".
 */
function extractPositionals(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}

async function handleSessionCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const store = new SessionStore(undefined, getHarnessStore());

  if (sub === "create") {
    const channelId = parseNamedArg(args, "--channel");
    const title = parseNamedArg(args, "--title") ?? "New conversation";

    if (!channelId) {
      console.error("Usage: rly session create --channel <id> [--title <text>]");
      process.exitCode = 1;
      return;
    }

    const session = await store.createSession(channelId, title);
    jsonOut(session);
    return;
  }

  if (sub === "list") {
    const channelId = parseNamedArg(args, "--channel");

    if (!channelId) {
      console.error("Usage: rly session list --channel <id>");
      process.exitCode = 1;
      return;
    }

    const sessions = await store.listSessions(channelId);
    jsonOut(sessions);
    return;
  }

  if (sub === "get") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");

    if (!channelId || !sessionId) {
      console.error("Usage: rly session get --channel <id> --session <id>");
      process.exitCode = 1;
      return;
    }

    const session = await store.getSession(channelId, sessionId);
    jsonOut(session);
    return;
  }

  if (sub === "update-claude-sid") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");
    const alias = parseNamedArg(args, "--alias");
    const sid = parseNamedArg(args, "--sid");

    if (!channelId || !sessionId || !alias || !sid) {
      console.error(
        "Usage: rly session update-claude-sid --channel <id> --session <id> --alias <name> --sid <claude_sid>"
      );
      process.exitCode = 1;
      return;
    }

    const session = await store.updateClaudeSessionId(channelId, sessionId, alias, sid);
    jsonOut(session);
    return;
  }

  if (sub === "append") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");
    const role = parseNamedArg(args, "--role") ?? "user";
    const alias = parseNamedArg(args, "--alias") ?? null;
    const metadataRaw = parseNamedArg(args, "--metadata");
    const content = extractPositionals(args).slice(1).join(" ");

    if (!channelId || !sessionId || !content) {
      console.error(
        "Usage: rly session append --channel <id> --session <id> --role <role> [--alias <name>] [--metadata <json>] <content>"
      );
      process.exitCode = 1;
      return;
    }

    let metadata: Record<string, string> | undefined;
    if (metadataRaw) {
      try {
        const parsed = JSON.parse(metadataRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = {};
          for (const [k, v] of Object.entries(parsed)) {
            metadata[k] = typeof v === "string" ? v : JSON.stringify(v);
          }
        } else {
          throw new Error("--metadata must be a JSON object of string values");
        }
      } catch (err) {
        console.error(
          `Invalid --metadata JSON: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exitCode = 1;
        return;
      }
    }

    await store.appendMessage(channelId, sessionId, {
      role,
      content,
      timestamp: new Date().toISOString(),
      agentAlias: alias,
      ...(metadata ? { metadata } : {}),
    });

    jsonOut({ ok: true });
    return;
  }

  if (sub === "update-last") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");
    const role = parseNamedArg(args, "--role") ?? "assistant";
    const alias = parseNamedArg(args, "--alias") ?? null;
    const content = extractPositionals(args).slice(1).join(" ");

    if (!channelId || !sessionId || !content) {
      console.error("Usage: rly session update-last --channel <id> --session <id> <content>");
      process.exitCode = 1;
      return;
    }

    await store.updateLastMessage(channelId, sessionId, {
      role,
      content,
      timestamp: new Date().toISOString(),
      agentAlias: alias,
    });

    jsonOut({ ok: true });
    return;
  }

  if (sub === "messages") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");
    const limit = Number(parseNamedArg(args, "--limit") ?? "500");

    if (!channelId || !sessionId) {
      console.error("Usage: rly session messages --channel <id> --session <id> [--limit N]");
      process.exitCode = 1;
      return;
    }

    const messages = await store.loadMessages(channelId, sessionId, limit);
    jsonOut(messages);
    return;
  }

  if (sub === "delete") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");

    if (!channelId || !sessionId) {
      console.error("Usage: rly session delete --channel <id> --session <id>");
      process.exitCode = 1;
      return;
    }

    // Look up the channel's repo paths so deleteSession can also prune any
    // `refs/harness-rewind/<sessionId>/*` refs this session accumulated.
    // Missing channel → treat as no repos (the session may already be
    // orphaned); deleteSession still scrubs the on-disk JSONL + index.
    const channelStoreForDelete = new ChannelStore(undefined, getHarnessStore());
    const channelForDelete = await channelStoreForDelete.getChannel(channelId);
    const repoPaths = channelForDelete?.repoAssignments?.map((r) => r.repoPath) ?? [];

    await store.deleteSession(channelId, sessionId, { repoPaths });
    jsonOut({ ok: true, deleted: sessionId });
    return;
  }

  console.error(
    "Usage: rly session <create|list|get|delete|update-claude-sid|append|update-last|messages>"
  );
  process.exitCode = 1;
}

async function handleChatCommand(
  args: string[],
  cwd: string,
  workspace: { paths: HarnessWorkspacePaths; status: HarnessServiceStatus }
): Promise<void> {
  const sub = args[0];

  if (sub === "system-prompt") {
    const channelId = parseNamedArg(args, "--channel");
    const repoPath = parseNamedArg(args, "--repo");
    const alias = parseNamedArg(args, "--alias");

    if (!channelId) {
      console.error(
        "Usage: rly chat system-prompt --channel <id> [--repo <path>] [--alias <name>]"
      );
      process.exitCode = 1;
      return;
    }

    const prompt = await buildSystemPrompt({ channelId, repoPath, alias });
    jsonOut({ prompt });
    return;
  }

  if (sub === "resolve-refs") {
    const channelId = parseNamedArg(args, "--channel");
    const message = extractPositionals(args).slice(1).join(" ");

    if (!channelId || !message) {
      console.error("Usage: rly chat resolve-refs --channel <id> <message>");
      process.exitCode = 1;
      return;
    }

    const result = await resolveChannelRefs({ message, currentChannelId: channelId });
    jsonOut(result);
    return;
  }

  if (sub === "mcp-config") {
    const repoPath = parseNamedArg(args, "--repo") ?? cwd;
    const path = findMcpConfig(repoPath);
    jsonOut({ path });
    return;
  }

  if (sub === "rewind-snapshot") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");
    if (!channelId || !sessionId) {
      console.error("Usage: rly chat rewind-snapshot --channel <id> --session <id>");
      process.exitCode = 1;
      return;
    }
    const result = await rewindSnapshot(channelId, sessionId);
    jsonOut(result);
    return;
  }

  if (sub === "rewind-apply") {
    const channelId = parseNamedArg(args, "--channel");
    const sessionId = parseNamedArg(args, "--session");
    const key = parseNamedArg(args, "--key");
    const messageTimestamp = parseNamedArg(args, "--message-timestamp");
    if (!channelId || !sessionId || !key || !messageTimestamp) {
      console.error(
        "Usage: rly chat rewind-apply --channel <id> --session <id> --key <ref-key> --message-timestamp <iso8601>"
      );
      process.exitCode = 1;
      return;
    }
    const result = await rewindApply(channelId, sessionId, key, messageTimestamp);
    jsonOut(result);
    return;
  }

  if (sub === "rewind") {
    await handleChatRewindCommand(args);
    return;
  }

  console.error(
    "Usage: rly chat <system-prompt|resolve-refs|mcp-config|rewind|rewind-snapshot|rewind-apply>"
  );
  process.exitCode = 1;
}

/**
 * `rly chat rewind --channel <id> --session <id> [--to <iso> | --interactive]`
 *
 * End-to-end rewind driver. Lists user messages with recorded `rewindKey`
 * metadata (the only kind we can roll back to), lets the caller pick one,
 * then chains the existing `rewindSnapshot`→`rewindApply` functions.
 * Matches what the GUI's `RewindConfirmModal` does, but with a
 * readline-based picker so scripts can also drive it via `--to`.
 *
 * Non-interactive mode (`--to`) takes a message timestamp (the exact ISO8601
 * stored on the persisted message), not a `rewindKey`. Timestamps are
 * visible in `rly session messages --json`; keys are an implementation
 * detail that only rewind ever touches.
 */
async function handleChatRewindCommand(args: string[]): Promise<void> {
  const channelId = parseNamedArg(args, "--channel");
  const sessionId = parseNamedArg(args, "--session");
  const toTimestamp = parseNamedArg(args, "--to");
  const interactive = args.includes("--interactive");

  if (!channelId || !sessionId) {
    console.error(
      "Usage: rly chat rewind --channel <id> --session <id> [--to <messageTimestamp> | --interactive]"
    );
    process.exitCode = 1;
    return;
  }

  const sessionStore = new SessionStore();
  const messages = await sessionStore.loadMessages(channelId, sessionId, 500);
  // Only user messages with a stored `rewindKey` can actually be rewound —
  // that's the metadata tag that pairs the message with a git ref.
  const candidates = messages
    .map((m, index) => ({ message: m, index }))
    .filter(
      (c) =>
        c.message.role === "user" &&
        typeof c.message.metadata?.rewindKey === "string" &&
        c.message.metadata.rewindKey.length > 0
    );

  if (candidates.length === 0) {
    console.error(
      "No rewindable messages found. Rewind only works for user turns written with a `rewindKey` metadata tag."
    );
    process.exitCode = 1;
    return;
  }

  let chosen: (typeof candidates)[number] | null = null;

  if (toTimestamp) {
    chosen = candidates.find((c) => c.message.timestamp === toTimestamp) ?? null;
    if (!chosen) {
      console.error(
        `No rewindable message with timestamp ${toTimestamp}. Available timestamps: ${candidates
          .map((c) => c.message.timestamp)
          .join(", ")}`
      );
      process.exitCode = 1;
      return;
    }
  } else if (interactive) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const recent = candidates.slice(-20);
      console.log("Rewindable user messages (most recent last):");
      for (let i = 0; i < recent.length; i += 1) {
        const c = recent[i];
        const preview = c.message.content.replace(/\s+/g, " ").slice(0, 60);
        console.log(`  [${i + 1}] ${c.message.timestamp}  ${preview}`);
      }
      const raw = (await rl.question("Pick a number (or Enter to cancel): ")).trim();
      if (!raw) {
        console.error("Cancelled.");
        process.exitCode = 1;
        return;
      }
      const picked = Number(raw);
      if (!Number.isInteger(picked) || picked < 1 || picked > recent.length) {
        console.error(`Invalid selection: ${raw}`);
        process.exitCode = 1;
        return;
      }
      chosen = recent[picked - 1];
    } finally {
      rl.close();
    }
  } else {
    console.error("Specify --to <messageTimestamp> or --interactive. Recent candidates:");
    for (const c of candidates.slice(-10)) {
      const preview = c.message.content.replace(/\s+/g, " ").slice(0, 60);
      console.error(`  ${c.message.timestamp}  ${preview}`);
    }
    process.exitCode = 1;
    return;
  }

  const key = String(chosen.message.metadata?.rewindKey ?? "");
  if (!key) {
    console.error("Chosen message is missing rewindKey metadata (data corruption?).");
    process.exitCode = 1;
    return;
  }

  // Snapshot first (captures current HEADs under the same key, so a later
  // rewind-undo could theoretically replay — today the key is the one on
  // the message, but fresh snapshots ensure refs exist even if the original
  // ones were GC'd). The GUI path skips re-snapshotting; we follow suit
  // and only apply.
  const result = await rewindApply(channelId, sessionId, key, chosen.message.timestamp);
  jsonOut({
    ok: true,
    target: {
      timestamp: chosen.message.timestamp,
      rewindKey: key,
      preview: chosen.message.content.slice(0, 120),
    },
    ...result,
  });
}

async function printRunsIndex(
  artifactStore: LocalArtifactStore,
  cwd: string,
  args: string[] = []
): Promise<void> {
  const recentRuns = await artifactStore.readRunsIndex();

  if (args.includes("--json")) {
    jsonOut(recentRuns.slice(0, 20));
    return;
  }

  const indexPath = `${cwd}/.relay/artifacts/runs-index.json`;

  console.log(`Runs index path: ${indexPath}`);
  console.log("");

  if (recentRuns.length === 0) {
    console.log("No runs found.");
    return;
  }

  console.log("Recent runs:");

  for (const entry of recentRuns.slice(0, 20)) {
    console.log(
      `- ${entry.runId} state=${entry.state} updated=${entry.updatedAt} ledger=${entry.phaseLedgerPath ?? "(missing)"} artifacts=${entry.artifactsRoot}`
    );
  }
}

async function printStatus(artifactStore: LocalArtifactStore, cwd: string): Promise<void> {
  const summary = await readWorkspaceSummary(artifactStore, cwd);

  console.log(`Workspace: ${cwd}`);
  console.log(`Global root: ${getGlobalRoot()}`);
  console.log(`Workspace dir: ${summary.paths.rootDir}`);
  console.log(`Artifacts dir: ${summary.paths.artifactsDir}`);
  console.log(`Runs index path: ${summary.paths.runsIndexPath}`);
  console.log("");
  console.log(`Service state: ${summary.status?.state ?? "not_initialized"}`);

  if (summary.status) {
    console.log(`Version: ${summary.status.version}`);
    console.log(`Updated: ${summary.status.updatedAt}`);
  }

  console.log("");

  if (summary.recentRuns.length === 0) {
    console.log("Recent runs: none");
    return;
  }

  console.log("Recent runs:");

  for (const entry of summary.recentRuns.slice(0, 5)) {
    console.log(
      `- ${entry.runId} state=${entry.state} updated=${entry.updatedAt} ledger=${entry.phaseLedgerPath ?? "(missing)"}`
    );
  }
}

async function inspectMcp(input: {
  cwd: string;
  args: string[];
  workspace: {
    paths: HarnessWorkspacePaths;
  };
  artifactStore: LocalArtifactStore;
}): Promise<void> {
  const attachHarnessMcp = !hasHarnessMcpOptOut(input.args);
  const provider = parseProviderArg(stripHarnessMcpOptOut(input.args));
  const providers = provider ? [provider] : (["claude", "codex"] as const);
  const invoker = new NodeCommandInvoker();
  const cliEntrypoint = resolveCliEntrypoint();

  console.log(`Workspace: ${input.cwd}`);
  console.log(`Harness MCP attached: ${attachHarnessMcp ? "yes" : "no"}`);
  console.log("");

  if (attachHarnessMcp) {
    const claudeConfigPath = await ensureClaudeMcpConfig({
      cwd: input.cwd,
      cliEntrypoint,
      paths: input.workspace.paths,
    });
    console.log(`Claude MCP config: ${claudeConfigPath}`);
    console.log(`Codex MCP server: relay -> ${cliEntrypoint} mcp-server --workspace ${input.cwd}`);
    console.log("");
  }

  for (const candidate of providers) {
    const result = await invoker.exec({
      command: candidate,
      args: attachHarnessMcp
        ? await buildWrappedAgentLaunchArgs({
            command: candidate,
            cwd: input.cwd,
            cliEntrypoint,
            userArgs: ["mcp", "list"],
            workspace: input.workspace,
            // `mcp list` is a probe, no approvals needed and no spawning of
            // long-running agents. Skip auto-approve propagation here.
            autoApprove: false,
          })
        : ["mcp", "list"],
      cwd: input.cwd,
      env: {
        RELAY_HOME: input.workspace.paths.rootDir,
        RELAY_ARTIFACTS_DIR: input.workspace.paths.artifactsDir,
        RELAY_RUNS_INDEX: input.workspace.paths.runsIndexPath,
      },
    });

    console.log(`${capitalize(candidate)} MCP servers:`);
    const output = result.stdout.trim() || result.stderr.trim() || "(no output)";
    console.log(output);

    if (result.exitCode !== 0) {
      console.log(`Exit code: ${result.exitCode}`);
    }

    console.log("");
  }
}

async function printDoctor(input: {
  cwd: string;
  args: string[];
  workspace: {
    paths: HarnessWorkspacePaths;
    status: HarnessServiceStatus;
  };
  artifactStore: LocalArtifactStore;
}): Promise<void> {
  await printUpStatus(input.workspace);
  console.log("");
  await printStatus(input.artifactStore, input.cwd);
  console.log("");
  await inspectMcp(input);
}

async function printUpStatus(input: {
  paths: {
    rootDir: string;
    artifactsDir: string;
    serviceStatusPath: string;
    runsIndexPath: string;
  };
  status: {
    version: string;
    updatedAt: string;
  };
}): Promise<void> {
  const globalRoot = getGlobalRoot();
  const workspaces = await listRegisteredWorkspaces();

  console.log("Relay is ready.");
  console.log(`Global root: ${globalRoot}`);
  console.log(`Workspace dir: ${input.paths.rootDir}`);
  console.log(`Artifacts dir: ${input.paths.artifactsDir}`);
  console.log(`Service status path: ${input.paths.serviceStatusPath}`);
  console.log(`Runs index path: ${input.paths.runsIndexPath}`);
  console.log(`Version: ${input.status.version}`);
  console.log(`Updated: ${input.status.updatedAt}`);

  if (workspaces.length > 1) {
    console.log("");
    console.log(`Registered workspaces (${workspaces.length}):`);

    for (const ws of workspaces) {
      console.log(`  ${ws.workspaceId} -> ${ws.repoPath}`);
    }
  }
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };

  return packageJson.version ?? "0.0.0";
}

async function printTopLevelHelp(): Promise<void> {
  const version = await readPackageVersion();
  const lines = [
    `rly v${version} — Relay CLI`,
    "",
    "Usage: rly <command> [options]",
    "",
    "Agents:",
    "  claude                   Launch Claude with Relay MCP attached",
    "  codex                    Launch Codex with Relay MCP attached",
    "  doctor                   Sanity-check env, tokens, MCP wiring",
    "  mcp-server               Start MCP stdio transport (invoked by agents)",
    "  serve                    Run the MCP HTTP/SSE server",
    "  inspect-mcp              Print advertised MCP tool definitions",
    "",
    "Channels & sessions:",
    "  channels                 List channels (most-recently-active first)",
    "  channel <subcommand>     Manage channels (create/update/archive/set-full-access/feed/post/...)",
    "  session <subcommand>     Manage session transcripts",
    "  board <channelId>        Kanban view of tickets",
    "  decisions <channelId>    List decisions with rationale",
    "  chat <subcommand>        Chat plumbing (rewind, system-prompt, resolve-refs, mcp-config)",
    "  crosslink <subcommand>   Cross-session discovery + messaging (status)",
    "",
    "Runs & approval:",
    "  run <request>            Classify + plan + execute a feature request",
    "  run --autonomous <ch>    Start an autonomous session against a channel's ticket board (AL-3)",
    "  approve <runId>          Approve a pending plan",
    "  reject <runId> [--feedback <text>]  Reject a pending plan",
    "  pending-plans [--json]   List runs awaiting plan-approval decisions",
    "  status                   Workspace paths + recent runs",
    "  list-runs                Recent persisted runs across workspaces",
    "  running                  Active tasks across every workspace",
    "",
    "Dashboards:",
    "  tui                      Launch the ratatui terminal dashboard",
    "  gui                      Launch the Tauri desktop app",
    "  dashboard                Launch the legacy web dashboard",
    "",
    "PR tracking:",
    "  pr-watch <pr>            Manually track a GitHub PR",
    "  pr-status                List tracked PRs with CI + review state",
    "",
    "Workspace:",
    "  up                       Register the current repo as a workspace",
    "  workspaces               List registered workspaces",
    "  welcome                  Interactive first-run walkthrough",
    "  config <subcommand>      Manage global config (add/remove project dirs)",
    "  rebuild                  Rebuild native artifacts (tui/gui)",
    "",
    "Misc:",
    "  version | --version      Print version",
    "",
    "Run `rly <command> --help` for command-specific help.",
    "Docs: https://github.com/jcast90/relay#readme",
  ];
  console.log(lines.join("\n"));
}

function resolveCliEntrypoint(): string {
  return fileURLToPath(new URL("../dist/cli.js", import.meta.url));
}

async function handleServeCommand(cwd: string, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: rly serve [--port <n>] [--host <host>] [--token <token>] [--workspace <id>]"
    );
    console.log("");
    console.log("Starts an HTTP/SSE MCP server exposing Relay's tool surface.");
    console.log("");
    console.log("Options:");
    console.log(
      "  --port <n>                         TCP port to bind (env: RELAY_PORT, default: 7420)"
    );
    console.log(
      "  --host <host>                      Host/interface (default: 127.0.0.1 / loopback only)"
    );
    console.log(
      "  --token <token>                    Require Authorization: Bearer <token> (env: RELAY_TOKEN)"
    );
    console.log(
      "  --workspace <id>                   Workspace id (required unless the current repo is registered via `rly up`)"
    );
    console.log(
      "  --allow-unauthenticated-remote     Opt-in: allow non-loopback --host without --token (DANGEROUS)"
    );
    console.log("");
    console.log("For multi-host deployments pass BOTH --host 0.0.0.0 AND --token explicitly.");
    return;
  }

  try {
    await runServeCommand(cwd, args);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const code = err?.code;
    if (code === "EADDRINUSE") {
      // Port already bound — user needs to pick a different one or stop the
      // conflicting process. Don't dump the raw stack.
      const port = parseNamedArg(args, "--port") ?? process.env.RELAY_PORT ?? "7420";
      console.error(`[rly serve] Port ${port} is already in use. Try --port <n>.`);
    } else if (code === "EACCES") {
      const port = parseNamedArg(args, "--port") ?? process.env.RELAY_PORT ?? "7420";
      const host = parseNamedArg(args, "--host") ?? "127.0.0.1";
      console.error(
        `[rly serve] Permission denied binding to ${host}:${port}. Try --port > 1024 or run with sudo.`
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[rly serve] Failed to start MCP server: ${msg}`);
    }
    process.exit(1);
  }
}

async function runServeCommand(cwd: string, args: string[]): Promise<void> {
  const portArg = parseNamedArg(args, "--port") ?? process.env.RELAY_PORT;
  const port = portArg ? Number(portArg) : 7420;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${portArg}`);
    process.exit(1);
  }

  // Loopback-by-default: MCP surface exposes sensitive tools (harness_dispatch,
  // plan approval). Opt-in to non-loopback via --host.
  const host = parseNamedArg(args, "--host") ?? "127.0.0.1";
  const token = parseNamedArg(args, "--token") ?? process.env.RELAY_TOKEN;
  const allowUnauthenticatedRemote = args.includes("--allow-unauthenticated-remote");

  let workspaceId = parseNamedArg(args, "--workspace");
  if (!workspaceId) {
    const workspaces = await listRegisteredWorkspaces();
    const match = workspaces.find((w) => w.repoPath === cwd);
    if (!match) {
      console.error(
        "No workspace id. Register the current repo with `rly up` or pass --workspace <id>."
      );
      process.exit(1);
    }
    workspaceId = match.workspaceId;
  }

  // Validation rules for the non-loopback + auth decision table live in
  // `serve-validation.ts` so tests can exercise them without shelling out a
  // CLI subprocess. This handler is responsible for surfacing the decision.
  const validation = validateServeOptions({ host, token, allowUnauthenticatedRemote });
  if (validation.kind === "error") {
    console.error(validation.message);
    process.exit(1);
  }
  for (const warning of validation.warnings) {
    console.warn(warning);
  }

  const handle = await startHttpMcpServer(
    async () => {
      const { handler, context } = await buildMcpMessageHandler(cwd);
      return { handler, cleanup: context.cleanup };
    },
    { port, host, authToken: token, workspaceId }
  );

  console.log(`Serving MCP at ${handle.url}`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Auth: ${token ? "Bearer token required" : "none (loopback only recommended)"}`);
  console.log("Press Ctrl+C to stop.");

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[rly serve] received ${signal}, shutting down...`);
    try {
      await handle.stop();
    } catch (error) {
      console.error("[rly serve] stop failed:", error instanceof Error ? error.message : error);
    }
    process.exit(0);
  };

  const onSignal = (signal: "SIGINT" | "SIGTERM") => (): void => {
    // Run the async shutdown and log any terminal error rather than letting
    // the promise reject into an unhandledRejection.
    shutdown(signal).catch((err) => {
      console.error(
        "[rly serve] shutdown failed:",
        err instanceof Error ? err.message : String(err)
      );
      process.exit(1);
    });
  };

  process.on("SIGINT", onSignal("SIGINT"));
  process.on("SIGTERM", onSignal("SIGTERM"));
}

function resolveWorkspaceRoot(cwd: string, args: string[]): string {
  const workspaceIndex = args.indexOf("--workspace");

  if (workspaceIndex === -1) {
    return cwd;
  }

  const workspaceRoot = args[workspaceIndex + 1];

  if (!workspaceRoot) {
    throw new Error("Expected a workspace path after --workspace.");
  }

  return workspaceRoot;
}

async function buildWrappedAgentLaunchArgs(input: {
  command: string;
  cwd: string;
  cliEntrypoint: string;
  userArgs: string[];
  workspace: {
    paths: HarnessWorkspacePaths;
  };
  autoApprove: boolean;
}): Promise<string[]> {
  // claude-* variants use the same MCP config as claude
  if (input.command === "claude" || input.command.startsWith("claude-")) {
    return buildClaudeLaunchArgs({
      userArgs: input.userArgs,
      mcpConfigPath: await ensureClaudeMcpConfig({
        cwd: input.cwd,
        cliEntrypoint: input.cliEntrypoint,
        paths: input.workspace.paths,
      }),
      autoApprove: input.autoApprove,
    });
  }

  return buildCodexLaunchArgs({
    userArgs: input.userArgs,
    cwd: input.cwd,
    cliEntrypoint: input.cliEntrypoint,
    autoApprove: input.autoApprove,
  });
}

function parseProviderArg(args: string[]): "claude" | "codex" | null {
  const candidate = args[0];

  if (candidate === "claude" || candidate === "codex") {
    return candidate;
  }

  return null;
}

function parseAgentOverrides(): Record<string, { provider?: "claude" | "codex"; model?: string }> {
  const overrides: Record<string, { provider?: "claude" | "codex"; model?: string }> = {};

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^HARNESS_AGENT_(\w+)_PROVIDER$/);

    if (match && value && (value === "claude" || value === "codex")) {
      const agentId = match[1].toLowerCase();
      overrides[agentId] = { ...overrides[agentId], provider: value };
    }

    const modelMatch = key.match(/^HARNESS_AGENT_(\w+)_MODEL$/);

    if (modelMatch && value) {
      const agentId = modelMatch[1].toLowerCase();
      overrides[agentId] = { ...overrides[agentId], model: value };
    }
  }

  return overrides;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
