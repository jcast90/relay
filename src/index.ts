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
  stripHarnessMcpOptOut
} from "./cli/agent-wrapper.js";
import { AgentRegistry } from "./agents/registry.js";
import { launchInteractiveCommand } from "./cli/launcher.js";
import {
  ensureHarnessWorkspace,
  type HarnessServiceStatus,
  type HarnessWorkspacePaths,
  readWorkspaceSummary
} from "./cli/workspace.js";
import {
  getGlobalRoot,
  listRegisteredWorkspaces
} from "./cli/workspace-registry.js";
import { LocalArtifactStore } from "./execution/artifact-store.js";
import { startMcpServer } from "./mcp/server.js";
import { VerificationRunner } from "./execution/verification-runner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { OrchestratorV2 } from "./orchestrator/orchestrator-v2.js";
import { ScriptedInvoker } from "./simulation/scripted-invoker.js";
import { ChannelStore } from "./channels/channel-store.js";
import { handleCrosslinkCommand } from "./crosslink/cli.js";
import { startDashboard } from "./tui/dashboard.js";

export async function main(): Promise<void> {
  const cwd = process.cwd();
  const command = process.argv[2] ?? "run";
  const args = process.argv.slice(3);
  const live = process.env.HARNESS_LIVE === "1";
  const packageVersion = await readPackageVersion();
  const workspace = await ensureHarnessWorkspace(cwd, packageVersion);
  const artifactStore = new LocalArtifactStore(workspace.paths.artifactsDir);

  if (command === "up") {
    await printUpStatus(workspace);
    return;
  }

  if (command === "status") {
    await printStatus(artifactStore, cwd);
    return;
  }

  if (command === "list-runs") {
    await printRunsIndex(artifactStore, cwd);
    return;
  }

  if (command === "list-workspaces") {
    await printWorkspaces();
    return;
  }

  if (command === "inspect-mcp") {
    await inspectMcp({
      cwd,
      args,
      workspace,
      artifactStore
    });
    return;
  }

  if (command === "doctor") {
    await printDoctor({
      cwd,
      args,
      workspace,
      artifactStore
    });
    return;
  }

  if (command === "dashboard") {
    await startDashboard();
    return;
  }

  if (command === "tui") {
    const tuiBinary = fileURLToPath(new URL("../tui/target/release/agent-harness-tui", import.meta.url));
    const exitCode = await launchInteractiveCommand({
      command: tuiBinary,
      args: [],
      cwd,
      env: {}
    });
    process.exitCode = exitCode;
    return;
  }

  if (command === "channels") {
    await printChannels();
    return;
  }

  if (command === "channel") {
    await handleChannelCommand(args);
    return;
  }

  if (command === "running") {
    await printRunningTasks();
    return;
  }

  if (command === "board") {
    await printTaskBoard(args[0] ?? "");
    return;
  }

  if (command === "decisions") {
    await printDecisions(args[0] ?? "");
    return;
  }

  if (command === "crosslink") {
    await handleCrosslinkCommand(args[0] ?? "status", args.slice(1));
    return;
  }

  if (command === "mcp-server") {
    await startMcpServer(resolveWorkspaceRoot(cwd, args));
    return;
  }

  if (command === "claude" || command === "codex") {
    const cliEntrypoint = resolveCliEntrypoint();
    const attachHarnessMcp = !hasHarnessMcpOptOut(args);
    const userArgs = stripHarnessMcpOptOut(args);
    const launchArgs = attachHarnessMcp
      ? await buildWrappedAgentLaunchArgs({
          command,
          cwd,
          cliEntrypoint,
          userArgs,
          workspace
        })
      : userArgs;
    const exitCode = await launchInteractiveCommand({
      command,
      args: launchArgs,
      cwd,
      env: {
        AGENT_HARNESS_HOME: workspace.paths.rootDir,
        AGENT_HARNESS_ARTIFACTS_DIR: workspace.paths.artifactsDir,
        AGENT_HARNESS_RUNS_INDEX: workspace.paths.runsIndexPath
      }
    });

    process.exitCode = exitCode;
    return;
  }

  const sequential = args.includes("--sequential");
  const defaultProvider = (process.env.HARNESS_PROVIDER ?? "claude") as "claude" | "codex";
  const agentOverrides = parseAgentOverrides();
  await registerAgentNames({ defaultProvider, overrides: agentOverrides });
  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd,
    invoker: live ? undefined : new ScriptedInvoker(cwd),
    defaultProvider,
    overrides: agentOverrides
  });

  for (const agent of agents) {
    registry.register(agent);
  }

  const verificationRunner = new VerificationRunner(
    new NodeCommandInvoker(),
    artifactStore
  );

  const featureRequest = "Build a basic harness scaffold that can select agents by role and specialty.";
  let run: Awaited<ReturnType<Orchestrator["run"]>>;

  try {
    if (sequential) {
      const orchestrator = new Orchestrator(
        registry,
        cwd,
        verificationRunner,
        artifactStore,
        workspace.paths.artifactsDir
      );
      run = await orchestrator.run(featureRequest);
    } else {
      const orchestratorV2 = new OrchestratorV2(
        registry,
        cwd,
        verificationRunner,
        artifactStore,
        workspace.paths.artifactsDir
      );
      run = await orchestratorV2.run(featureRequest);
    }
  } catch (error) {
    console.error("Orchestrator failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
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
    console.log(
      `- [${name}] ${item.phaseId} attempt=${item.attempt} ${item.summary}`
    );
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

async function printChannels(): Promise<void> {
  const store = new ChannelStore();
  const channels = await store.listChannels();

  if (channels.length === 0) {
    console.log("No channels. Create one with: agent-harness channel create <name>");
    return;
  }

  console.log(`Channels (${channels.length}):`);

  for (const ch of channels) {
    const activeMembers = ch.members.filter((m) => m.status === "active").length;
    console.log(`  ${ch.name} (${ch.channelId})`);
    console.log(`    ${ch.description}`);
    console.log(`    Status: ${ch.status} | Members: ${activeMembers}/${ch.members.length} | Refs: ${ch.pinnedRefs.length}`);
    console.log("");
  }
}

async function handleChannelCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const store = new ChannelStore();

  if (sub === "create") {
    const name = args[1];
    if (!name) {
      console.error("Usage: agent-harness channel create <name> [description]");
      process.exitCode = 1;
      return;
    }
    const description = args.slice(2).join(" ") || `Channel for ${name}`;
    const channel = await store.createChannel({ name, description });
    console.log(`Channel created: ${channel.name} (${channel.channelId})`);
    return;
  }

  if (!sub) {
    console.error("Usage: agent-harness channel <channelId|create>");
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

async function printRunningTasks(): Promise<void> {
  const workspaces = await listRegisteredWorkspaces();
  const activeStates = new Set([
    "CLASSIFYING", "DRAFT_PLAN", "PLAN_REVIEW", "AWAITING_APPROVAL",
    "DESIGN_DOC", "PHASE_READY", "PHASE_EXECUTE", "TEST_FIX_LOOP",
    "REVIEW_FIX_LOOP", "TICKETS_EXECUTING", "TICKETS_COMPLETE"
  ]);

  let count = 0;

  for (const ws of workspaces) {
    const wsArtifactStore = new LocalArtifactStore(
      `${getGlobalRoot()}/workspaces/${ws.workspaceId}/artifacts`
    );
    const runs = await wsArtifactStore.readRunsIndex();

    for (const run of runs) {
      if (activeStates.has(run.state)) {
        console.log(`  ${run.runId} [${run.state}] ${run.featureRequest.slice(0, 80)}`);
        console.log(`    Workspace: ${ws.repoPath}`);
        if (run.channelId) console.log(`    Channel: ${run.channelId}`);
        console.log("");
        count += 1;
      }
    }
  }

  if (count === 0) {
    console.log("No running tasks.");
  } else {
    console.log(`${count} active task(s).`);
  }
}

async function printTaskBoard(channelId: string): Promise<void> {
  if (!channelId) {
    console.error("Usage: agent-harness board <channelId>");
    process.exitCode = 1;
    return;
  }

  const store = new ChannelStore();
  const channel = await store.getChannel(channelId);

  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exitCode = 1;
    return;
  }

  const runLinks = await store.readRunLinks(channelId);

  if (runLinks.length === 0) {
    console.log("No runs linked to this channel.");
    return;
  }

  const board: Record<string, Array<{ ticketId: string; title: string }>> = {};

  for (const link of runLinks) {
    const wsStore = new LocalArtifactStore(
      `${getGlobalRoot()}/workspaces/${link.workspaceId}/artifacts`
    );
    const tickets = await wsStore.readTicketLedger(link.runId);
    if (!tickets) continue;

    for (const ticket of tickets) {
      if (!board[ticket.status]) board[ticket.status] = [];
      board[ticket.status].push({ ticketId: ticket.ticketId, title: ticket.title });
    }
  }

  for (const [status, tickets] of Object.entries(board)) {
    console.log(`[${status.toUpperCase()}] (${tickets.length})`);
    for (const t of tickets) {
      console.log(`  ${t.ticketId}: ${t.title}`);
    }
    console.log("");
  }
}

async function printDecisions(channelId: string): Promise<void> {
  if (!channelId) {
    console.error("Usage: agent-harness decisions <channelId>");
    process.exitCode = 1;
    return;
  }

  const store = new ChannelStore();
  const channel = await store.getChannel(channelId);

  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exitCode = 1;
    return;
  }

  const decisions = await store.listDecisions(channelId);

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

async function printWorkspaces(): Promise<void> {
  const globalRoot = getGlobalRoot();
  const workspaces = await listRegisteredWorkspaces();

  console.log(`Global root: ${globalRoot}`);
  console.log("");

  if (workspaces.length === 0) {
    console.log("No workspaces registered. Run `agent-harness up` in a repo to register it.");
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

async function printRunsIndex(
  artifactStore: LocalArtifactStore,
  cwd: string
): Promise<void> {
  const recentRuns = await artifactStore.readRunsIndex();
  const indexPath = `${cwd}/.agent-harness/artifacts/runs-index.json`;

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

async function printStatus(
  artifactStore: LocalArtifactStore,
  cwd: string
): Promise<void> {
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
      paths: input.workspace.paths
    });
    console.log(`Claude MCP config: ${claudeConfigPath}`);
    console.log(
      `Codex MCP server: agent_harness -> ${cliEntrypoint} mcp-server --workspace ${input.cwd}`
    );
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
            workspace: input.workspace
          })
        : ["mcp", "list"],
      cwd: input.cwd,
      env: {
        AGENT_HARNESS_HOME: input.workspace.paths.rootDir,
        AGENT_HARNESS_ARTIFACTS_DIR: input.workspace.paths.artifactsDir,
        AGENT_HARNESS_RUNS_INDEX: input.workspace.paths.runsIndexPath
      }
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

  console.log("Agent Harness is ready.");
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
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8")
  ) as { version?: string };

  return packageJson.version ?? "0.0.0";
}

function resolveCliEntrypoint(): string {
  return fileURLToPath(new URL("../dist/cli.js", import.meta.url));
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
  command: "claude" | "codex";
  cwd: string;
  cliEntrypoint: string;
  userArgs: string[];
  workspace: {
    paths: HarnessWorkspacePaths;
  };
}): Promise<string[]> {
  if (input.command === "claude") {
    return buildClaudeLaunchArgs({
      userArgs: input.userArgs,
      mcpConfigPath: await ensureClaudeMcpConfig({
        cwd: input.cwd,
        cliEntrypoint: input.cliEntrypoint,
        paths: input.workspace.paths
      })
    });
  }

  return buildCodexLaunchArgs({
    userArgs: input.userArgs,
    cwd: input.cwd,
    cliEntrypoint: input.cliEntrypoint
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
