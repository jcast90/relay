import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createLiveAgents } from "./agents/factory.js";
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
import { LocalArtifactStore } from "./execution/artifact-store.js";
import { startMcpServer } from "./mcp/server.js";
import { VerificationRunner } from "./execution/verification-runner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { ScriptedInvoker } from "./simulation/scripted-invoker.js";

export async function main(): Promise<void> {
  const cwd = process.cwd();
  const command = process.argv[2] ?? "run";
  const args = process.argv.slice(3);
  const live = process.env.HARNESS_LIVE === "1";
  const packageVersion = await readPackageVersion();
  const workspace = await ensureHarnessWorkspace(cwd, packageVersion);
  const artifactStore = new LocalArtifactStore(workspace.paths.artifactsDir);

  if (command === "up") {
    printUpStatus(workspace);
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

  const registry = new AgentRegistry();
  const agents = createLiveAgents({
    cwd,
    invoker: live ? undefined : new ScriptedInvoker(cwd)
  });

  for (const agent of agents) {
    registry.register(agent);
  }

  const verificationRunner = new VerificationRunner(
    new NodeCommandInvoker(),
    artifactStore
  );
  const orchestrator = new Orchestrator(
    registry,
    cwd,
    verificationRunner,
    artifactStore
  );
  const run = await orchestrator.run(
    "Build a basic harness scaffold that can select agents by role and specialty."
  );
  const recentRuns = await artifactStore.readRunsIndex();

  console.log(`Run id: ${run.id}`);
  console.log(`Run state: ${run.state}`);
  console.log("");
  console.log(`Execution mode: ${live ? "live CLI agents" : "scripted simulation"}`);
  console.log("");
  console.log("Planned phases:");

  for (const phase of run.plan?.phases ?? []) {
    console.log(`- ${phase.id}: ${phase.title} [${phase.specialty}]`);
  }

  console.log("");
  console.log("Evidence:");

  for (const item of run.evidence) {
    console.log(
      `- ${item.phaseId} ${item.agentId} attempt=${item.attempt} summary=${JSON.stringify(item.summary)}`
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

  console.log("");
  console.log(`Phase ledger path: ${run.phaseLedgerPath ?? "(not written)"}`);

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
  console.log(`Harness home: ${summary.paths.rootDir}`);
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
  printUpStatus(input.workspace);
  console.log("");
  await printStatus(input.artifactStore, input.cwd);
  console.log("");
  await inspectMcp(input);
}

function printUpStatus(input: {
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
}): void {
  console.log("Agent Harness is ready.");
  console.log(`Harness home: ${input.paths.rootDir}`);
  console.log(`Artifacts dir: ${input.paths.artifactsDir}`);
  console.log(`Service status path: ${input.paths.serviceStatusPath}`);
  console.log(`Runs index path: ${input.paths.runsIndexPath}`);
  console.log(`Version: ${input.status.version}`);
  console.log(`Updated: ${input.status.updatedAt}`);
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
