/**
 * One-shot seeder: creates (or reuses) a `#autonomous-loop` channel with the
 * Relay repo as its sole assignment, then writes the autonomous-execution
 * ticket plan to the channel board so `rly board <channelId>` and the GUI
 * render it immediately.
 *
 * Usage:
 *   tsx scripts/seed-autonomous-loop-tickets.ts
 *   RELAY_REPO=/path/to/relay tsx scripts/seed-autonomous-loop-tickets.ts
 *
 * Idempotency: tickets are upserted by ticketId so re-running replaces the
 * board with the latest plan. Channel creation is skipped when a channel
 * named `autonomous-loop` already exists.
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
  registerWorkspace,
} from "../src/cli/workspace-registry.js";
import { buildRunId } from "../src/orchestrator/orchestrator-v2.js";
import { join } from "node:path";

const REPO = process.env.RELAY_REPO ?? process.cwd();
const CHANNEL_NAME = "autonomous-loop";

// Effort band: widened to XS/S/M/L/XL to match AL-6's audit-agent
// schema (`AuditEffortEstimateSchema`). Existing plan entries below
// still use S/M/L; the widened type just unblocks the full band for
// future plan additions and keeps every Effort surface in the repo
// consistent. See `scripts/push-tickets-to-github.ts` for the GH
// project-field side of the same widening.
type Effort = "XS" | "S" | "M" | "L" | "XL";

interface PlanItem {
  id: string;
  effort: Effort;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

const PLAN: PlanItem[] = [
  {
    id: "AL-0",
    effort: "M",
    title: "Per-channel full-access mode + subprocess plumbing",
    objective:
      "Add `fullAccess: boolean` to the Channel model. When set, agent subprocesses spawned on behalf of that channel pass `--dangerously-skip-permissions` (Claude) and the equivalent for Codex. Scoping is per-channel, NOT per-workspace: two channels sharing a repo have independent flags. Surface as a toggle in the GUI channel header and a `rly channel set-full-access <id> <on|off>` CLI command. Decision-board entry recorded on every state change so there is a durable audit trail.",
    acceptanceCriteria: [
      "Channel schema extended with fullAccess (default false); back-compat preserved for old channel files",
      "Spawner reads the channel's fullAccess flag and threads the subprocess flag through; channels without the flag still prompt as today",
      "Two channels on the same repo: toggling A's flag does not affect B",
      "Audit entry written to the decisions board on every set-full-access toggle (who, when, channel, new state)",
      "CLI + GUI affordance work end-to-end",
    ],
    dependsOn: [],
  },
  {
    id: "AL-1",
    effort: "M",
    title: "Token budget tracker",
    objective:
      "Wrap the Claude/Codex invokers so every request accumulates input+output tokens under a session key. Surface `{used, total, pct}` via an event bus the scheduler can subscribe to. Persistence to `~/.relay/sessions/<sessionId>/budget.jsonl` so a restart can resume mid-session accounting. No dollar math yet — that's a follow-up once the first flow is working.",
    acceptanceCriteria: [
      "Token usage recorded for every Claude API call made on behalf of an autonomous session",
      "Bus emits pct updates; tests cover 0%, 50%, 85%, 95%, 100% thresholds",
      "Budget file survives process restart and resumes accumulation",
      "Non-autonomous sessions unaffected (no performance regression, no extra writes)",
    ],
    dependsOn: [],
  },
  {
    id: "AL-2",
    effort: "M",
    title: "Session lifecycle states + wall-clock watchdog",
    objective:
      "Add a session lifecycle state machine (`planning → dispatching → winding_down → audit → done | killed`) persisted per session. Watchdog thread checks both token budget (85%/95% thresholds) and wall-clock (`--max-hours`, default 8h). Transitions emit events on the same bus as AL-1.",
    acceptanceCriteria: [
      "State persisted at `~/.relay/sessions/<sessionId>/lifecycle.json`",
      "Transitions are one-way (no going back from winding_down to dispatching)",
      "Wall-clock kill fires independent of token budget; kills are clean (running ticket finishes) not hard-kill",
      "Unit tests cover every transition + both kill paths",
    ],
    dependsOn: ["AL-1"],
  },
  {
    id: "AL-3",
    effort: "S",
    title: "`rly run --autonomous` CLI entrypoint",
    objective:
      "Thin CLI command that: takes a channelId, budget-tokens, max-hours, and trust mode (supervised|god — god is a no-op stub this PR). Loads the channel, verifies it has repo assignments, records the autonomous session start in the decisions board, and hands off to the autonomous-loop driver.",
    acceptanceCriteria: [
      "Flags: --budget-tokens, --max-hours, --trust, --allow-repo (repeatable)",
      "Errors cleanly when channel has no repos or the ticket board is empty",
      "Emits a single decision-board entry tagged `autonomous_session_started` with the full arg set so the user can audit it",
    ],
    dependsOn: ["AL-0", "AL-2"],
  },
  {
    id: "AL-4",
    effort: "L",
    title: "Autonomous-loop driver",
    objective:
      "New `src/orchestrator/autonomous-loop.ts`. Subscribes to budget+lifecycle bus. Pulls the next ready ticket from the channel board and hands it off to the correct repo-admin via `ticket.assignedAlias` (see AL-13). In `winding_down` it stops handing out new tickets and lets in-flight finish. All dispatches run under the channel's full-access flag from AL-0. Cross-repo coordination uses the protocol from AL-16.",
    acceptanceCriteria: [
      "Given a 3-ticket seeded board with tickets targeting 2 repos, driver routes correctly and completes all three without user input",
      "Budget event at 85% flips state to winding_down; no new tickets started after that",
      "Wall-clock kill mid-ticket: ticket marked failed, next ticket not started, session ends cleanly",
      "Integration test exercises a cross-repo success path with a scripted invoker",
    ],
    dependsOn: ["AL-3", "AL-14", "AL-16"],
  },
  {
    id: "AL-11",
    effort: "M",
    title: "Define repo-admin agent role",
    objective:
      "New long-lived foreman role. Narrow tool allowlist: read ticket board, read decisions, read git log, spawn worker agents into worktrees, query PR state. Explicitly DENIED: edit files, run tests, merge PRs. System prompt emphasizes board-is-memory: repo-admin caches only the working set and re-reads decisions/board when it needs to reconsult.",
    acceptanceCriteria: [
      "`src/agents/repo-admin.ts` defines the role + system prompt + MCP tool allowlist",
      "Spawning repo-admin yields a session with ONLY the allowed tools (assert via the MCP capability report)",
      "Attempting to call denied tools from repo-admin results in a clear denial response, not silent failure",
      "Documentation snippet in `agent_docs/` explains the foreman/crew split",
    ],
    dependsOn: [],
  },
  {
    id: "AL-12",
    effort: "M",
    title: "Per-repo repo-admin session lifecycle",
    objective:
      "At autonomous-session boot, spawn one repo-admin session per entry in the channel's repoAssignments. Track liveness, restart if the process dies, graceful shutdown on session end. Sessions live for the duration of the autonomous session — not forever.",
    acceptanceCriteria: [
      "Channel with 3 repoAssignments boots 3 repo-admin sessions, each scoped to its repo's cwd",
      "Killing a repo-admin process triggers an automatic restart; ticket in-flight in its queue survives",
      "Autonomous-session shutdown cleanly terminates all repo-admin sessions",
      "Test covers the boot/restart/shutdown cycles",
    ],
    dependsOn: ["AL-11"],
  },
  {
    id: "AL-13",
    effort: "M",
    title: "Ticket routing: channel scheduler → repo-admin",
    objective:
      "Replace the single-cwd dispatch in `src/orchestrator/dispatch.ts`. Scheduler reads `ticket.assignedAlias`, looks up the matching repoAssignment, hands the ticket to that repo's repo-admin via the crosslink message bus. Repo-admin owns the ticket's worker lifecycle from that point on. Unassigned tickets route to the channel's primary repo's repo-admin.",
    acceptanceCriteria: [
      "Ticket with `assignedAlias: 'backend'` reaches backend repo-admin, not frontend",
      "Unassigned ticket on a single-repo channel still routes correctly (back-compat)",
      "Routing failures (alias doesn't match any repoAssignment) surface as a ticket status update, not a silent drop",
    ],
    dependsOn: ["AL-12"],
  },
  {
    id: "AL-14",
    effort: "L",
    title: "Repo-admin spawns workers in per-ticket worktrees",
    objective:
      "When repo-admin receives a ticket, it creates a dedicated git worktree (existing sandbox infrastructure), spawns the worker agent (atlas / frontend / eng-manager / ...) scoped to that worktree, monitors until a PR opens, then hands back control. Worktree destroyed on PR merge.",
    acceptanceCriteria: [
      "Two tickets in the same repo get distinct worktrees; workers cannot see each other's state",
      "Worker agents inherit the channel's full-access flag (AL-0) at spawn time",
      "Worktree cleanup happens on PR merge regardless of which trust mode merged it",
      "If a worker fails, repo-admin surfaces the failure to the board and does not swallow it",
    ],
    dependsOn: ["AL-13"],
  },
  {
    id: "AL-15",
    effort: "M",
    title: "Memory-shed protocol: token-budget session cycling",
    objective:
      "Each repo-admin subscribes to its own session token budget. When its context hits 60% of its declared ceiling, repo-admin writes a one-line summary of in-flight state to the decisions board, kills its own session, and respawns from a fresh session that rebuilds its working set by reading the board + recent decisions. User-facing framing: 'repo-admin forgets completed tickets'; implementation: automatic session recycling driven by token pressure.",
    acceptanceCriteria: [
      "Cycling is invisible to the channel scheduler — in-flight ticket routing survives it",
      "Post-cycle repo-admin can correctly answer 'what's in flight right now' by reading the board (no stale cached state)",
      "Summary written to decisions includes: active tickets, worktrees in use, PRs open, cycle reason (budget/manual)",
      "Test: force cycle mid-ticket, assert ticket completes and no state is lost",
    ],
    dependsOn: ["AL-12", "AL-1"],
  },
  {
    id: "AL-16",
    effort: "M",
    title: "Repo-admin ↔ repo-admin coordination protocol",
    objective:
      "Typed crosslink messages (not free-text chat) for inter-repo coordination. Shapes: `BlockedOnRepo { requester, blocker, ticketId, reason }`, `RepoReady { ticketId, prUrl }`, `MergeOrderProposal { sequence }`. Repo-admin A can request work from repo-admin B and wait for the typed response. Scheduler observes the protocol for merge-order and dependency resolution.",
    acceptanceCriteria: [
      "Message shapes defined in `src/crosslink/messages.ts` (or similar) with zod schemas",
      "Repo-admin prompt documents when to use each shape; agent learns to request structured coordination, not free-text",
      "Integration test: ticket in repo-A blocks on repo-B's ticket completing; coordination completes without deadlock",
      "Malformed messages rejected with a clear error, not silently ignored",
    ],
    dependsOn: ["AL-14"],
  },
  {
    id: "AL-17",
    effort: "S",
    title: "GitHub project: two-axis routing mirror",
    objective:
      "Update `scripts/push-tickets-to-github.ts` so the GitHub project reflects the (role, repo) routing model: `Assignees` field mirrors the worker agent role, new `Repo` single-select field carries the target repo alias, new `Admin` text field names the repo-admin owning the ticket. Re-run push is idempotent.",
    acceptanceCriteria: [
      "Two new project fields created via GraphQL mutation (idempotent — skip if already exist)",
      "Push script populates Repo from `ticket.assignedAlias`; Admin from `repo-admin-<alias>`",
      "Re-running the push against an already-synced board updates field values without creating duplicate issues",
      "README section documents the (role, repo) convention so contributors know how to pick up work",
    ],
    dependsOn: [],
  },
  {
    id: "AL-5",
    effort: "M",
    title: "PR reviewer wrapper",
    objective:
      "New `src/integrations/pr-reviewer.ts`. When a ticket completes and opens a PR, spawn the `pr-review-toolkit:code-reviewer` subagent against it. Parses the review output for BLOCKING/NIT findings. Under supervised trust mode, marks the PR as `ready_for_human_ack`. Under god mode, merges (future — stubbed in this PR).",
    acceptanceCriteria: [
      "Review runs automatically when a PR is opened by an autonomous ticket",
      "Findings parsed into structured form and stored next to the PR row",
      "Supervised mode: PR row gets `ready_for_human_ack` tag; god mode path is behind a flag that currently logs and no-ops",
      "Manual PRs (opened by a user) not reviewed — scoped to autonomous-opened PRs only",
    ],
    dependsOn: ["AL-4"],
  },
  {
    id: "AL-6",
    effort: "M",
    title: "Post-completion audit agent (proposals only)",
    objective:
      "When ledger is all-green AND budget has ≥15% headroom, spawn an audit agent. Prompt: 'Given the tickets just completed and the current codebase state, propose the next 3–5 tickets prioritized by user value.' Agent reads decisions board, recent PRs, git log. Output written as `audit_proposal` decision entries — one per proposed ticket. No auto-creation of tickets; that's deferred until god mode lands.",
    acceptanceCriteria: [
      "Fires exactly once per session, after the last ticket completes",
      "Skips silently if budget headroom <15% or ledger had failures",
      "Each proposal writes a decision entry with title, rationale, suggested dependencies, effort estimate",
      "Integration test with a two-ticket board verifies the audit fires after both complete",
    ],
    dependsOn: ["AL-4"],
  },
  {
    id: "AL-7",
    effort: "M",
    title: "Approvals queue + trust-mode gate",
    objective:
      "Under supervised trust mode, every action needing user ack (PR auto-merge, audit-proposed ticket creation) writes a record to `~/.relay/approvals/<sessionId>/queue.jsonl` instead of executing. God mode bypasses the queue (to be implemented when god mode lands). Records are: `{id, sessionId, kind, payload, createdAt, status: pending|approved|rejected, decidedAt?}`.",
    acceptanceCriteria: [
      "queue.jsonl atomic-appends per record",
      "Every ack-requiring call site threads the trust mode explicitly — no implicit globals",
      "Supervised sessions never auto-merge; god mode path still behind the flag from AL-5",
      "Tests verify both modes and the approve/reject state transitions",
    ],
    dependsOn: ["AL-5", "AL-6"],
  },
  {
    id: "AL-8",
    effort: "L",
    title: "Approvals surfaces — CLI + TUI + GUI",
    objective:
      "Three equivalent ways to drain the queue: (a) `rly approve next|all|reject <id> [--feedback ...]` CLI; (b) TUI approvals pane; (c) GUI right-pane section with approve/reject buttons on each pending record. All three read/write the same `queue.jsonl` files so approval state stays consistent across surfaces.",
    acceptanceCriteria: [
      "CLI: list, approve-single, approve-all, reject-with-feedback all functional",
      "TUI: pane renders pending approvals, keyboard shortcuts to approve/reject, live refresh on queue writes",
      "GUI: right-pane section lists pending approvals per selected channel, approve/reject buttons work, refresh tick picks up new items",
      "Integration test: action enqueued in one surface, approved via another, state reflects correctly in the third",
    ],
    dependsOn: ["AL-7"],
  },
  {
    id: "AL-9",
    effort: "S",
    title: "Kill switch (STOP file)",
    objective:
      "Autonomous-loop checks `~/.relay/sessions/<sessionId>/STOP` at the start of each tick (default 20s). Presence of the file flips lifecycle state to `winding_down`. CLI: `rly session stop <sessionId>` drops the file; GUI gets a 'Kill session' button in the session-status header.",
    acceptanceCriteria: [
      "Loop honors STOP file within one tick (≤20s)",
      "CLI + GUI both produce a STOP file that the loop reliably picks up",
      "Killed session still runs the post-completion audit IF the ledger was all-green before the kill; otherwise skips audit",
    ],
    dependsOn: ["AL-4"],
  },
  {
    id: "AL-10",
    effort: "M",
    title: "GUI session status header + approvals panel",
    objective:
      "CenterPane header (when an autonomous session is active on the selected channel) shows: lifecycle state, tokens used %, hours remaining, current-ticket link. RightPane gets the approvals panel from AL-8. Kill-session button in the header.",
    acceptanceCriteria: [
      "Header auto-refreshes every 5s without flicker",
      "Tokens % + hours remaining match what the CLI reports",
      "Approvals panel only renders when supervised mode AND queue is non-empty",
      "Visual contrast matches the existing Catppuccin theme; no new color drift",
    ],
    dependsOn: ["AL-8", "AL-9"],
  },
];

async function main(): Promise<void> {
  const channelStore = new ChannelStore();
  const channels = await channelStore.listChannels();

  const workspace = (await resolveWorkspaceForRepo(REPO)) ?? (await registerWorkspace(REPO));

  let channel = channels.find((c) => c.name === CHANNEL_NAME);
  if (!channel) {
    channel = await channelStore.createChannel({
      name: CHANNEL_NAME,
      description:
        "Autonomous long-running agent loop — plan → dispatch → review → audit. Ticket prefix AL-.",
      repoAssignments: [
        {
          alias: "relay",
          workspaceId: workspace.workspaceId,
          repoPath: REPO,
        },
      ],
      primaryWorkspaceId: workspace.workspaceId,
    });
  }

  const artifactsDir = join(getWorkspaceDir(workspace.workspaceId), "artifacts");
  const artifactStore = new LocalArtifactStore(artifactsDir, getHarnessStore());

  const runId = buildRunId();
  const now = new Date().toISOString();

  const tickets: TicketDefinition[] = PLAN.map((item) => ({
    id: item.id,
    title: `[${item.effort}] ${item.title}`,
    objective: item.objective,
    specialty: "general",
    acceptanceCriteria: item.acceptanceCriteria,
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: item.dependsOn,
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 },
  }));

  const ticketLedger = initializeTicketLedger(tickets, runId);

  const classification = {
    tier: "architectural" as const,
    rationale:
      "Builds a long-running autonomous execution loop with budget tracking, trust modes, PR review integration, and post-completion audit. Touches storage, orchestrator, execution, and all three UIs.",
    suggestedSpecialties: ["general"] as string[],
    estimatedTicketCount: tickets.length,
    needsDesignDoc: false,
    needsUserApproval: true,
  };

  const run: HarnessRun = {
    id: runId,
    featureRequest:
      "Autonomous long-running agent loop: plan → ticket dispatch → PR review → post-completion audit. Supervised trust mode first; god mode is a follow-up. Per-channel full-access flag for subprocess permission skipping.",
    state: "AWAITING_APPROVAL",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId: channel.channelId,
    classification,
    plan: null,
    ticketPlan: {
      version: 1,
      task: {
        title: "Autonomous loop rollout",
        featureRequest:
          "Autonomous long-running agent loop with budget tracking + trust modes + PR review integration + audit.",
        repoRoot: REPO,
      },
      classification,
      tickets,
      finalVerification: { commands: ["pnpm build", "pnpm test"] },
      docsToUpdate: ["README.md"],
    },
    events: [],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    ticketLedger,
    ticketLedgerPath: null,
    runIndexPath: null,
  };

  await artifactStore.saveRunSnapshot(run);
  await artifactStore.saveTicketLedger({ runId, ticketLedger });

  await artifactStore.saveRunsIndex({
    entry: {
      runId,
      featureRequest: run.featureRequest,
      state: run.state,
      channelId: channel.channelId,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      phaseLedgerPath: null,
      artifactsRoot: join(artifactsDir, runId),
    },
  });

  await channelStore.upsertChannelTickets(channel.channelId, ticketLedger);
  await channelStore.linkRun(channel.channelId, runId, workspace.workspaceId);

  console.log(
    JSON.stringify(
      {
        channelId: channel.channelId,
        channelName: channel.name,
        runId,
        workspaceId: workspace.workspaceId,
        ticketCount: tickets.length,
        artifactsDir: join(artifactsDir, runId),
        boardCommand: `rly board ${channel.channelId}`,
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
