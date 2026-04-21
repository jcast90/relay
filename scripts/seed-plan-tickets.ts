/**
 * One-shot seeder: creates a synthetic Relay run for the storage/executor/MCP
 * refactor plan, writes the unified channel ticket board, and links the run
 * so both `rly board <channelId>` and the GUI render the plan's tickets.
 *
 * Usage:
 *   tsx scripts/seed-plan-tickets.ts <channelId>
 *   RELAY_REPO=/path/to/other/repo tsx scripts/seed-plan-tickets.ts <channelId>
 *
 * Repo resolution: `RELAY_REPO` env var wins; otherwise `process.cwd()` is
 * used so the seeder works on any machine without editing source.
 *
 * Idempotency: not provided — each invocation creates a new run and upserts
 * the channel board. Archive/remove unwanted runs manually if re-seeded.
 */

import { ChannelStore } from "../src/channels/channel-store.js";
import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { getHarnessStore } from "../src/storage/factory.js";
import type { HarnessRun } from "../src/domain/run.js";
import type { TicketDefinition } from "../src/domain/ticket.js";
import { initializeTicketLedger } from "../src/domain/ticket.js";
import {
  getWorkspaceDir,
  resolveWorkspaceForRepo,
  registerWorkspace
} from "../src/cli/workspace-registry.js";
import { buildRunId } from "../src/orchestrator/orchestrator-v2.js";
import { join } from "node:path";

const REPO = process.env.RELAY_REPO ?? process.cwd();

type Phase = 0 | 1 | 2 | 3 | 4 | 5;
type Effort = "S" | "M" | "L";

interface PlanItem {
  id: string;
  phase: Phase;
  effort: Effort;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  specialty: TicketDefinition["specialty"];
  dependsOn: string[];
}

const PLAN: PlanItem[] = [
  {
    id: "T-001",
    phase: 0,
    effort: "M",
    title: "Define HarnessStore interface + file impl",
    objective:
      "Introduce a HarnessStore interface (getDoc/putDoc/listDocs/deleteDoc, appendLog/readLog, putBlob/getBlob, mutate, watch) and implement FileHarnessStore over the current ~/.relay layout. No production callers yet.",
    acceptanceCriteria: [
      "src/storage/store.ts exports the interface with full types",
      "FileHarnessStore passes unit tests covering all methods",
      "LocalArtifactStore remains untouched this ticket"
    ],
    specialty: "general",
    dependsOn: []
  },
  {
    id: "T-002",
    phase: 0,
    effort: "S",
    title: "Composition root for store injection",
    objective:
      "Consolidate HarnessStore construction to a single point in src/index.ts driven by HARNESS_STORE env. Pass it into downstream modules by ctor; delete scattered homedir/join imports.",
    acceptanceCriteria: [
      "pnpm build && pnpm test pass",
      "grep of node:fs/promises outside src/storage returns only an explicit allowlist",
      "Env var HARNESS_STORE=file selects FileHarnessStore"
    ],
    specialty: "general",
    dependsOn: ["T-001"]
  },
  {
    id: "T-003",
    phase: 0,
    effort: "S",
    title: "Define AgentExecutor + SandboxProvider interfaces",
    objective:
      "Add AgentExecutor (start -> ExecutionHandle with wait/kill/stream) and SandboxProvider (create/destroy/resolvePath) in src/execution/. Ship a NoopExecutor for tests; orchestrator untouched.",
    acceptanceCriteria: [
      "Types compile across the repo",
      "Existing orchestrator + scheduler tests unchanged and passing",
      "A test double AgentExecutor is available for unit tests"
    ],
    specialty: "general",
    dependsOn: []
  },
  {
    id: "T-101",
    phase: 1,
    effort: "M",
    title: "Migrate ChannelStore to HarnessStore",
    objective:
      "Rewrite channel-store.ts to accept an injected HarnessStore. Channel docs use putDoc; feed.jsonl becomes appendLog. Preserve the normalize/denormalize JSON-tag contract for Rust/GUI readers.",
    acceptanceCriteria: [
      "All existing channel tests pass",
      "A migration test reads fixtures written by the pre-migration code and validates round-trip",
      "GUI + Rust TUI continue to parse the feed correctly"
    ],
    specialty: "general",
    dependsOn: ["T-001", "T-002"]
  },
  {
    id: "T-102",
    phase: 1,
    effort: "S",
    title: "Migrate workspace registry + session store",
    objective:
      "Move src/cli/workspace-registry.ts and src/cli/session-store.ts onto HarnessStore; drop hardcoded GLOBAL_ROOT.",
    acceptanceCriteria: [
      "rly up / rly status / rly list-workspaces all work unchanged",
      "Pre-migration workspace registry JSON still reads successfully",
      "Tests updated to inject a store"
    ],
    specialty: "general",
    dependsOn: ["T-101"]
  },
  {
    id: "T-103",
    phase: 1,
    effort: "M",
    title: "Migrate LocalArtifactStore to store-backed blobs/logs",
    objective:
      "Collapse LocalArtifactStore onto HarnessStore: docs for snapshots/classifications/ledgers, blobs for stdout/stderr, log for events.jsonl. Orchestrator unchanged.",
    acceptanceCriteria: [
      "End-to-end `pnpm demo` produces an equivalent artifact tree",
      "Orchestrator + scheduler tests unchanged",
      "Artifacts round-trip via readCommandResult / readFailureClassification"
    ],
    specialty: "general",
    dependsOn: ["T-101"]
  },
  {
    id: "T-104",
    phase: 1,
    effort: "S",
    title: "Migrate crosslink + agent-names + decisions",
    objective:
      "Remaining fs-direct modules (src/crosslink/store.ts, src/domain/agent-names.ts, and decision files inside channels) switch to HarnessStore.",
    acceptanceCriteria: [
      "rly crosslink status, rly decisions, named agents all work",
      "No new hardcoded homedir() calls introduced",
      "Unit tests updated to inject store"
    ],
    specialty: "general",
    dependsOn: ["T-101"]
  },
  {
    id: "T-105",
    phase: 1,
    effort: "M",
    title: "Unify ticket storage on channel board",
    objective:
      "Make channels/<id>/tickets.json the canonical live ticket store for both chat-created and orchestrator-generated tickets. Tag each entry with an optional runId. Keep per-run ticket-ledger.json as the immutable decomposition snapshot. Update chat system prompt to the full TicketLedgerEntry schema. Point rly board and GUI Board at the same source.",
    acceptanceCriteria: [
      "Orchestrator runs and chat sessions produce indistinguishable ticket entries on the channel board",
      "rly board and GUI Board render identical contents",
      "Legacy per-run-ledger readers fall back cleanly when channel board is empty"
    ],
    specialty: "general",
    dependsOn: []
  },
  {
    id: "T-201",
    phase: 2,
    effort: "M",
    title: "GitWorktreeSandbox provider",
    objective:
      "Implement SandboxProvider that creates one git worktree per active ticket, keyed by runId/ticketId. Cleanup on success; preserve on failure.",
    acceptanceCriteria: [
      "Two concurrent tickets on the same repo use separate worktrees",
      "Killing mid-ticket leaves worktree + .relay-state.json on disk",
      "Worktrees are removed after successful completion"
    ],
    specialty: "general",
    dependsOn: ["T-003"]
  },
  {
    id: "T-202",
    phase: 2,
    effort: "M",
    title: "LocalChildProcessExecutor",
    objective:
      "Implement AgentExecutor wrapping the existing CommandInvoker + dispatch path. ExecutionHandle exposes wait/kill/stream. Scheduler replaces dispatch() with executor.start(...).wait().",
    acceptanceCriteria: [
      "TicketScheduler constructed with AgentExecutor instead of dispatch callback",
      "All orchestrator tests pass",
      "Stream yields at least start/stdout/exit events"
    ],
    specialty: "general",
    dependsOn: ["T-003", "T-201"]
  },
  {
    id: "T-203",
    phase: 2,
    effort: "M",
    title: "Resume-on-crash for orphaned tickets",
    objective:
      "On harness start, scan for orphan sandboxes + state checkpoints; re-enter the scheduler for recoverable tickets, park unresumable ones as 'recovered' for user review.",
    acceptanceCriteria: [
      "kill -9 during a ticket -> restart -> ticket resumes and completes",
      "Recovered tickets surface in rly board",
      "Integration test covers kill-restart-complete cycle"
    ],
    specialty: "general",
    dependsOn: ["T-202", "T-103", "T-105"]
  },
  {
    id: "T-204",
    phase: 2,
    effort: "S",
    title: "Global executor concurrency cap",
    objective:
      "Add a semaphore above TicketScheduler keyed on the AgentExecutor. Config via HARNESS_MAX_AGENTS or settings store.",
    acceptanceCriteria: [
      "Two concurrent runs with 3 tickets each + cap=4 -> max 4 in-flight agents",
      "Cap respects hot-reload of the config value",
      "Metric/log line on block/unblock"
    ],
    specialty: "general",
    dependsOn: ["T-202"]
  },
  {
    id: "T-301",
    phase: 3,
    effort: "M",
    title: "Stuck-agent detection",
    objective:
      "Track last tool-use/output event per ExecutionHandle. A patroller thread fires stuck_agent if silence exceeds a configurable threshold (default 3m).",
    acceptanceCriteria: [
      "A simulated hang fires stuck_agent within threshold + 10s",
      "Threshold configurable per ticket/run",
      "Event posted to channel feed"
    ],
    specialty: "general",
    dependsOn: ["T-202"]
  },
  {
    id: "T-302",
    phase: 3,
    effort: "M",
    title: "Recovery actions on stuck tickets",
    objective:
      "On stuck_agent: kill + retry within ticket retry policy. On retries exhausted: mark failed_stuck and trigger escalation.",
    acceptanceCriteria: [
      "Single hang recovers by retry",
      "Repeated hang escalates via harness_escalate",
      "Ticket ledger ends in failed_stuck status when exhausted"
    ],
    specialty: "general",
    dependsOn: ["T-301"]
  },
  {
    id: "T-303",
    phase: 3,
    effort: "S",
    title: "Escalation MCP tool + router",
    objective:
      "New MCP tool harness_escalate({severity, reason, runId, channelId?}). Severity P0/P1/P2 fans out: channel (always), email webhook (P1+), pager (P0). Config in store under settings/escalation.",
    acceptanceCriteria: [
      "Three integration tests, one per severity",
      "Channel always receives an escalation post",
      "Webhook/pager endpoints configurable at runtime"
    ],
    specialty: "general",
    dependsOn: ["T-101", "T-105"]
  },
  {
    id: "T-304",
    phase: 3,
    effort: "S",
    title: "TUI/GUI surface for stuck + escalated state",
    objective:
      "New ticket statuses visible in rly board, Rust TUI, and Tauri GUI. Real-time update of status changes.",
    acceptanceCriteria: [
      "rly board renders stuck + escalated tickets distinctly",
      "Rust TUI and Tauri GUI show the new statuses",
      "Status changes propagate within a render tick"
    ],
    specialty: "general",
    dependsOn: ["T-301", "T-303"]
  },
  {
    id: "T-401",
    phase: 4,
    effort: "M",
    title: "HTTP/SSE MCP transport",
    objective:
      "Add HttpSseMcpTransport alongside stdio. Token-based auth scoped per workspace. Entrypoint: rly serve --port 7420.",
    acceptanceCriteria: [
      "External Claude session with remote MCP URL can call harness_list_runs",
      "Auth: missing/invalid token rejected",
      "Existing stdio path unchanged"
    ],
    specialty: "general",
    dependsOn: ["T-002"]
  },
  {
    id: "T-402",
    phase: 4,
    effort: "L",
    title: "PostgresHarnessStore",
    objective:
      "Second impl of HarnessStore: JSONB docs, append-only log table, S3/GCS blobs, pg_notify for watch. SQL migrations under src/storage/migrations/.",
    acceptanceCriteria: [
      "pnpm demo works end-to-end against Postgres",
      "Two harness processes on the same DB don't corrupt state",
      "Migrations run idempotently"
    ],
    specialty: "general",
    dependsOn: ["T-001"]
  },
  {
    id: "T-403",
    phase: 4,
    effort: "L",
    title: "PodExecutor + PVCSandbox (K8s)",
    objective:
      "AgentExecutor impl that creates a K8s Job wrapping the Claude/Codex container image. Workdir on a PVC cloned from git via init container. Logs stream back over SSE.",
    acceptanceCriteria: [
      "2-ticket demo against a kind cluster completes",
      "Artifacts land in the configured HarnessStore",
      "Failed pods leave logs + PVC preserved for inspection"
    ],
    specialty: "devops",
    dependsOn: ["T-202", "T-401"]
  },
  {
    id: "T-404",
    phase: 4,
    effort: "S",
    title: "Dockerfile + daemon container image",
    objective:
      "Dockerfile bundles node + Claude/Codex CLIs + the relay daemon. docker-compose.yml for quickstart (daemon + Postgres).",
    acceptanceCriteria: [
      "docker compose up boots a working relay over HTTP backed by Postgres",
      "Image is reproducible (no host mounts required)",
      "README quickstart section added"
    ],
    specialty: "devops",
    dependsOn: ["T-401", "T-402"]
  },
  {
    id: "T-501",
    phase: 5,
    effort: "M",
    title: "Graphify integration as opt-in plugin",
    objective:
      "New src/integrations/graphify.ts + MCP wrapper. ensureGraph(workspaceId) builds graphify-out/ on demand. Proxy graphify MCP tools (query_graph, get_node, get_neighbors, shortest_path). Planner prompt update. Config flag off by default.",
    acceptanceCriteria: [
      "Plugin off: harness behavior unchanged",
      "Plugin on: planner classification pulls graph results instead of grep for architecture queries",
      "Graph rebuild triggered on branch switch inside the sandbox worktree, not the user's repo"
    ],
    specialty: "general",
    dependsOn: ["T-401", "T-102"]
  },
  {
    id: "T-502",
    phase: 5,
    effort: "S",
    title: "Hooks-base + role overrides",
    objective:
      "Layered config: ~/.relay/hooks-base.json + hooks-overrides/{role}.json + hooks-overrides/{workspace}__{role}.json. Merge at spawn, write per-agent --settings.",
    acceptanceCriteria: [
      "Adding hooks-overrides/atlas.json affects only Atlas sessions",
      "Merge precedence matches docs: base -> role -> workspace+role",
      "No regression to existing single-settings callers"
    ],
    specialty: "general",
    dependsOn: ["T-102"]
  },
  {
    id: "T-503",
    phase: 5,
    effort: "S",
    title: "Agent mail protocol (1:1 async inbox)",
    objective:
      "Per-agent mailbox namespace in HarnessStore. MCP tools agent_mail_send / agent_mail_check. Distinct from channels (many-to-many) and crosslink (session discovery).",
    acceptanceCriteria: [
      "Atlas can DM an implementer; recipient sees message on next tool call",
      "Mail survives restarts",
      "Tests cover send / check / unread counting"
    ],
    specialty: "general",
    dependsOn: ["T-101"]
  },
  {
    id: "T-504",
    phase: 5,
    effort: "L",
    title: "Formula/Molecule DAG templates (deferred)",
    objective:
      "TOML templates under ~/.relay/formulas/*.toml that plug into the planner as reusable plan structures (release, add-endpoint, etc). Low priority until repeat workflows materialize.",
    acceptanceCriteria: [
      "A formula TOML is discovered and selectable by the planner",
      "Selected formula produces a deterministic ticket plan",
      "At least one shipped formula exercised by the demo"
    ],
    specialty: "general",
    dependsOn: ["T-304", "T-204"]
  }
];

async function main(): Promise<void> {
  const channelId = process.argv[2];
  if (!channelId) {
    console.error("Usage: tsx scripts/seed-plan-tickets.ts <channelId>");
    process.exit(1);
  }

  const channelStore = new ChannelStore();
  const channel = await channelStore.getChannel(channelId);
  if (!channel) {
    console.error(`Channel not found: ${channelId}`);
    process.exit(1);
  }

  const workspace =
    (await resolveWorkspaceForRepo(REPO)) ?? (await registerWorkspace(REPO));
  const artifactsDir = join(getWorkspaceDir(workspace.workspaceId), "artifacts");
  const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());

  const runId = buildRunId();
  const now = new Date().toISOString();

  const tickets: TicketDefinition[] = PLAN.map((item) => ({
    id: item.id,
    title: `[P${item.phase} · ${item.effort}] ${item.title}`,
    objective: item.objective,
    specialty: item.specialty,
    acceptanceCriteria: item.acceptanceCriteria,
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: item.dependsOn,
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 }
  }));

  const ticketLedger = initializeTicketLedger(tickets, runId);

  const classification = {
    tier: "architectural" as const,
    rationale:
      "Cross-cutting refactor across storage, execution, and transport layers; enables cloud deployment without breaking local usage.",
    suggestedSpecialties: ["general", "devops"] as string[],
    estimatedTicketCount: tickets.length,
    needsDesignDoc: false,
    needsUserApproval: true,
    crosslinkRepos: []
  };

  const run: HarnessRun = {
    id: runId,
    featureRequest:
      "Pluggable Relay: storage + executor + MCP transport; adopt select Gas Town concepts; optional graphify plugin",
    state: "AWAITING_APPROVAL",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId,
    classification,
    plan: null,
    ticketPlan: {
      version: 1,
      task: {
        title: "Pluggable Relay refactor",
        featureRequest:
          "Pluggable Relay: storage + executor + MCP transport; adopt select Gas Town concepts; optional graphify plugin",
        repoRoot: REPO
      },
      classification,
      tickets,
      finalVerification: { commands: ["pnpm build", "pnpm test"] },
      docsToUpdate: ["README.md"]
    },
    events: [],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    ticketLedger,
    ticketLedgerPath: null,
    runIndexPath: null
  };

  // Per-run snapshot (immutable decomposition record).
  await artifactStore.saveRunSnapshot(run);
  await artifactStore.saveTicketLedger({ runId, ticketLedger });

  // Runs index entry.
  await artifactStore.saveRunsIndex({
    entry: {
      runId,
      featureRequest: run.featureRequest,
      state: run.state,
      channelId,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      phaseLedgerPath: null,
      artifactsRoot: join(artifactsDir, runId)
    }
  });

  // Unified live ticket board — rly board + GUI both read this.
  await channelStore.writeChannelTickets(channelId, ticketLedger);
  await channelStore.linkRun(channelId, runId, workspace.workspaceId);

  console.log(
    JSON.stringify(
      {
        runId,
        channelId,
        workspaceId: workspace.workspaceId,
        ticketCount: tickets.length,
        artifactsDir: join(artifactsDir, runId)
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
