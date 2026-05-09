<!-- refreshed: 2026-05-09 -->
# Architecture

**Analysis Date:** 2026-05-09

## System Overview

Relay is a four-process system that shares a single source of truth on disk
(`~/.relay/`). The three dashboards (CLI, TUI, Tauri GUI) never talk to each
other — they all read and write the same JSON / JSONL files via the shared
`crates/harness-data/` Rust crate (TUI/GUI) or `src/storage/file-store.ts`
plus the bespoke `ChannelStore` (TS/CLI). The TS orchestrator is the only
process that drives the pipeline; everything else is a viewer.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                      Surfaces (read same files, three views)                │
├──────────────────────┬─────────────────────────┬───────────────────────────┤
│   CLI dashboard      │     Rust TUI            │   Tauri GUI               │
│  `src/index.ts`      │  `tui/src/main.rs`      │  `gui/src-tauri/src/`     │
│  `src/tui/dashboard` │  `tui/src/ui.rs`        │  `gui/src/App.tsx`        │
└──────────┬───────────┴────────┬────────────────┴───────────┬───────────────┘
           │ HarnessStore +     │ harness_data crate         │ harness_data crate
           │ ChannelStore (TS)  │ (Rust, read-mostly)        │ + Tauri IPC
           ▼                    ▼                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                Persistent state — `~/.relay/` (disk authoritative)          │
│  channels/<id>.json     channels/<id>/feed.jsonl    sections.json           │
│  channels/<id>/tickets.json    channels/<id>/decisions/<decId>.json         │
│  channels/<id>/runs.json       channels/<id>/sessions.json                  │
│  channels/<id>/sessions/<sessId>.jsonl                                      │
│  workspace-registry.json   workspaces/<wsId>/...   sessions/<sessId>/...    │
│  crosslink-session/<id>.json   crosslink-mailbox/<to>__<msg>.json           │
│  decision/<channelId>:<decId>.json   channel-tickets/<channelId>.json       │
│  agent-name/...   run-artifacts/...   approvals/<sessId>/queue.jsonl        │
│  config.env   provider-profiles.json   gui-settings.json                    │
└────────────┬───────────────────────────────────────────────────────────────┘
             ▲ writes
             │
┌────────────┴───────────────────────────────────────────────────────────────┐
│                       TypeScript Orchestrator (src/)                        │
│  classifier → planner (`draft_plan`) → decomposer → scheduler              │
│   → executor → verification-runner → PR-poller / follow-up dispatcher       │
│                                                                            │
│  Side surfaces: MCP server (`src/mcp/`), crosslink coordinator             │
│  (`src/crosslink/`), tracker / SCM plugins (`src/integrations/`),          │
│  agent registry + CLI adapters (`src/agents/`).                            │
└────────────┬───────────────────────────────────────────────────────────────┘
             │ spawn (sanitized env)
             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│   Coding-agent CLIs: `claude`, `codex` (per-ticket child processes,         │
│   sandboxed in git worktrees, talk back to Relay over MCP via stdio)        │
└────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI dispatch | Parse argv, bootstrap workspace, route to subcommand | `src/index.ts` |
| Orchestrator (v2) | Drive a single run through classifier → planner → decomposer → scheduler → completion | `src/orchestrator/orchestrator-v2.ts` |
| Classifier | Tier a request (`trivial` / `bugfix` / `chore` / `feature_small` / `feature_large` / `architectural`) via heuristics + LLM | `src/orchestrator/classifier.ts` |
| Ticket decomposer | Turn a phase plan into a ticket DAG (parallelizable units of work) | `src/orchestrator/ticket-decomposer.ts` |
| Ticket scheduler | Drain the DAG with bounded concurrency, dispatch each ticket through dispatch-callback or `AgentExecutor`, mirror status to channel board | `src/orchestrator/ticket-scheduler.ts` |
| Approval gate | Persist plan, wait for `rly approve` / `reject` (architectural + large-feature tiers) | `src/orchestrator/approval-gate.ts` |
| Autonomous loop | Long-running loop that re-fires the orchestrator on tickets pulled from a backlog | `src/orchestrator/autonomous-loop.ts` |
| Agent registry | Resolve `WorkRequest → Agent` based on role + specialty | `src/agents/registry.ts` |
| CLI agent adapters | Spawn `claude` / `codex` subprocesses, parse JSON / stream-json output back into `AgentResult` | `src/agents/cli-agents.ts` |
| Command invoker | Sanitize env, exec child, capture stdout/stderr, optionally stream lines | `src/agents/command-invoker.ts` |
| Executor | Optional alternative to dispatch — owns sandbox + child process lifecycle for ticket execution | `src/execution/local-child-process-executor.ts` |
| Verification runner | Execute allow-listed verification commands, write artifacts, decide pass/fail/recoverable | `src/execution/verification-runner.ts` |
| ChannelStore | All writes/reads of `channels/<id>/*` (feed, tickets, decisions, runs, sessions). Append-only feed; atomic tmp-rename on doc writes | `src/channels/channel-store.ts` |
| SectionStore | Sidebar grouping for channels (`sections.json`) | `src/channels/section-store.ts` |
| HarnessStore | Pluggable store interface (`getDoc / putDoc / appendLog / readLog / mutate / watch`) — file impl + Postgres impl | `src/storage/store.ts`, `src/storage/file-store.ts`, `src/storage/postgres-store.ts` |
| Artifact store | Per-run JSON artifacts under `run-artifacts/<runId>/` (classification, plan, ticket-ledger, design-doc, command outputs) | `src/execution/artifact-store.ts` |
| MCP server | JSON-RPC server exposing `channel_*`, `crosslink_*`, `coordination_*`, `pr_review_*` tools to coding-agent sessions | `src/mcp/server.ts` |
| Crosslink coordinator | Cross-session messaging + session discovery (`~/.relay/crosslink-*`) | `src/crosslink/coordinator.ts`, `src/crosslink/store.ts` |
| Tracker plugins | Pull issues from GitHub Issues / Linear into a unified `HarnessIssue` | `src/integrations/tracker.ts`, `src/integrations/linear-mirror.ts`, `src/integrations/github-projects/` |
| SCM plugin | GitHub PR open / list / CI / review fetch | `src/integrations/scm.ts` |
| PR poller | Watch tracked PRs, detect CI failure / review-requested transitions, enqueue follow-ups via `FollowUpDispatcher` | `src/integrations/pr-poller.ts`, `src/integrations/scheduler-follow-up-dispatcher.ts` |
| Provider-profile env mutex | Serialize `process.env` mutation when loading AO plugins | `src/integrations/plugin-env-mutex.ts` |
| Rust shared crate | `~/.relay/` reader for TUI + GUI (one source of truth for both) | `crates/harness-data/src/lib.rs` |
| Rust TUI | Ratatui dashboard (chat / board / decisions tabs) | `tui/src/main.rs`, `tui/src/ui.rs` |
| Tauri backend | Native shell for the GUI — also owns "spawn agent in user's Terminal" | `gui/src-tauri/src/lib.rs` |
| Tauri frontend | React + Vite chat UI bound to Tauri commands | `gui/src/App.tsx`, `gui/src/components/` |

## Pattern Overview

**Overall:** Pipeline orchestrator + pluggable adapters + on-disk message bus.

**Key Characteristics:**
- **Disk is authoritative.** Every subsystem reads and writes `~/.relay/` directly. No long-lived in-memory state shared between processes; the file layout *is* the API.
- **Atomic writes everywhere.** Any doc under `~/.relay/` goes through tmp-file + `rename`. Logs (`feed.jsonl`, mailboxes, queue.jsonl) are append-only — never rewritten in place. See `src/channels/channel-store.ts` and `src/storage/file-store.ts` for the canonical patterns.
- **Append-only feeds, one-file-per-id docs.** Channel decisions are one file per decision id (`channels/<id>/decisions/<decId>.json`); the feed is one shared `feed.jsonl`. This shape is hard-coded into the Rust crate at `crates/harness-data/src/lib.rs::sessions_dir` / `feed.jsonl` references — moving a path silently breaks the dashboards.
- **`HarnessStore` interface, two backends.** `FileHarnessStore` (default, single-process) and `PostgresHarnessStore` (multi-writer). Most subsystems write through `HarnessStore.putDoc / appendLog / mutate`; `ChannelStore` keeps direct filesystem access for the channel layout because the Rust readers expect it.
- **Pluggable adapters at every external edge.** `Agent`, `CommandInvoker`, `AgentExecutor`, `HarnessTracker`, `HarnessScm`, `HarnessStore`, `PollerHandle` are all interfaces. Production wires real impls from `src/index.ts`; tests inject `ScriptedInvoker` (`src/simulation/scripted-invoker.ts`) and `FakeHarnessStore`.
- **Scripted vs live mode.** `HARNESS_LIVE=1` switches the orchestrator's invoker from `ScriptedInvoker` to `NodeCommandInvoker`. Tests assume scripted; live mode is reserved for adapter-plumbing tests and real CLI use.

## Layers

**`src/cli/` (CLI surface):**
- Purpose: Argv parsing, workspace bootstrap, subcommand launchers, agent-wrapper flag plumbing, GUI/TUI launch.
- Location: `src/cli/`
- Contains: Subcommand handlers (`launch-gui-tui.ts`, `rebuild.ts`, `welcome.ts`, `install.ts`), `paths.ts` (`~/.relay/` resolver), `workspace-registry.ts`, `session-store.ts`, `chat-context.ts`.
- Depends on: `src/orchestrator/`, `src/channels/`, `src/storage/`, `src/agents/`, `src/integrations/`.
- Used by: `bin/rly.mjs` → `src/cli.ts` → `src/index.ts::main`.

**`src/orchestrator/` (pipeline):**
- Purpose: Drive a single feature request from text to merged PR.
- Location: `src/orchestrator/`
- Contains: classifier, planner (delegated via `dispatch({kind:"draft_plan"})`), decomposer, scheduler, approval-gate, autonomous-loop (multi-run driver), failure-routing, ticket-runner, ticket-router, repo-admin pool/session, worker-spawner, worktree-sweep, audit-agent, session-summary, stop-file-watcher.
- Depends on: `src/agents/`, `src/execution/`, `src/channels/`, `src/integrations/`, `src/domain/`.
- Used by: `src/index.ts` (`run` command), `src/cli/run-autonomous.ts`.

**`src/agents/` (provider adapters):**
- Purpose: Resolve the right CLI for a ticket and exec it with the right env / args.
- Location: `src/agents/`
- Contains: `registry.ts`, `cli-agents.ts` (Claude + Codex adapters), `command-invoker.ts` (env-sanitizing spawner), `factory.ts`, `provider-profile-lookup.ts`, `repo-admin.ts` (long-lived MCP-only sessions).
- Depends on: `src/domain/agent.ts`, `src/mcp/role-allowlist.ts`.
- Used by: `src/orchestrator/`, `src/cli/launcher.ts`.

**`src/execution/` (sandbox + checks):**
- Purpose: `AgentExecutor` (start/wait/kill an `ExecutionHandle`), sandbox provider (git worktree), verification command runner, artifact persistence.
- Location: `src/execution/`
- Contains: `executor.ts` (interface), `local-child-process-executor.ts`, `noop-executor.ts`, `sandbox.ts` + `sandboxes/git-worktree.ts`, `verification-runner.ts`, `artifact-store.ts`.
- Depends on: `src/agents/command-invoker.ts`, `src/storage/`, `src/domain/`.
- Used by: `src/orchestrator/ticket-scheduler.ts` (executor path), `src/orchestrator/orchestrator-v2.ts`.

**`src/channels/` (chat + ticket board state):**
- Purpose: Single owner of `~/.relay/channels/`. Reads/writes the channel manifest, append-only feed, ticket board, decisions, runs index, sessions index.
- Location: `src/channels/`
- Contains: `channel-store.ts` (the big one), `section-store.ts`, `board-resolver.ts` (resolve "the board" across runs), `ao-notifier.ts` (cross-process notify).
- Depends on: `src/storage/store.ts`, `src/cli/paths.ts`, `src/domain/channel.ts` + `decision.ts` + `ticket.ts`.
- Used by: orchestrator (mirrors ticket status, posts run lifecycle entries), MCP `channel_*` tools, CLI subcommands, `src/cli/chat-context.ts`.

**`src/storage/` (pluggable persistence):**
- Purpose: Generic key/value-ish primitives — docs, logs, blobs, atomic mutate.
- Location: `src/storage/`
- Contains: `store.ts` (interface), `file-store.ts`, `postgres-store.ts`, `factory.ts` (process-wide singleton), `namespaces.ts` (`STORE_NS.channelFeed` etc.), `migrations/` (Postgres DDL), `provider-profile-store.ts`.
- Depends on: nothing internal — leaf layer.
- Used by: every other layer.

**`src/integrations/` (external SaaS):**
- Purpose: `HarnessTracker` (issues), `HarnessScm` (PRs), PR poller, Linear mirror, GitHub Projects sync. Loaded as "AO plugins" — env mutex required.
- Location: `src/integrations/`
- Depends on: `src/agents/command-invoker.ts` (subprocess shell-outs to `gh`), external HTTP.
- Used by: `src/orchestrator/`, `src/cli/pr-watcher-factory.ts`.

**`src/mcp/` (MCP server):**
- Purpose: Expose `channel_*`, `crosslink_*`, `coordination_*`, `pr_review_*` tools to coding-agent sessions over JSON-RPC stdio (or HTTP for `rly serve`).
- Location: `src/mcp/`
- Contains: `server.ts`, `channel-tools.ts`, `coordination-tools.ts`, `pr-review-tool.ts`, `role-allowlist.ts`, `serve-validation.ts`, `http-transport.ts`.
- Depends on: `src/channels/`, `src/crosslink/`, `src/orchestrator/dispatch.ts`, `src/orchestrator/approval-gate.ts`.

**`src/crosslink/` (cross-session messaging):**
- Purpose: One Claude session reaches another running session by id; messages live in mailboxes (`crosslink-mailbox/<to>__<msg>.json`).
- Location: `src/crosslink/`
- Contains: `store.ts`, `coordinator.ts`, `cli.ts`, `tools.ts`, `hook.ts` (claude-code hook payload), `ipc-bridge.ts`, `messages.ts`, `types.ts`, `ipc-paths.ts`.
- Used by: MCP server, claude-code hook scripts.

**`src/domain/` (shared types):**
- Purpose: TS types + zod schemas for everything that crosses a boundary. Mirrored in `crates/harness-data/src/lib.rs`.
- Location: `src/domain/`
- Contains: `agent.ts`, `channel.ts`, `classification.ts`, `decision.ts`, `phase-plan.ts`, `pr-lifecycle.ts`, `pr-row.ts`, `provider-profile.ts`, `run.ts`, `session.ts`, `specialty.ts`, `state-machine.ts`, `ticket.ts`, `tier-mapper.ts`, `tool-activity.ts`, `tracker-config.ts`, `agent-names.ts`.
- Depends on: nothing internal.

**`src/simulation/` (test invoker):**
- Purpose: Deterministic, scripted replacement for `NodeCommandInvoker`. Default invoker when `HARNESS_LIVE` is unset.
- Location: `src/simulation/scripted-invoker.ts`

**`src/cli.ts` / `src/index.ts` (entry point):**
- `bin/rly.mjs` runs `src/cli.ts` via `tsx`. `cli.ts` calls `main()` from `src/index.ts`. `main()` parses argv and routes to one of ~50 subcommands defined inline as `if (command === "...") { ... }` blocks.

## Data Flow

### Primary Request Path: `rly run "<feature request>"`

1. **CLI bootstrap** (`src/index.ts::main`, around `if (command === "run")` near line 354) — parses argv, ensures workspace dir, builds `LocalArtifactStore`, `AgentRegistry`, `VerificationRunner`, `OrchestratorV2`.
2. **`OrchestratorV2.run(featureRequest)`** (`src/orchestrator/orchestrator-v2.ts:110`) — creates a `HarnessRun`, mints a `Channel` via `ChannelStore.createChannel`, posts a `run_started` feed entry.
3. **Classify** (`src/orchestrator/classifier.ts::classifyRequest`) — heuristic first (`classifyByHeuristic`), LLM fallback via `dispatch({kind:"classify_request"})`. Result persisted as a `run-artifacts/<runId>/classification.json` artifact and the channel's `tier` field is patched.
4. **Plan** (orchestrator-v2 line ~203) — `dispatch({kind:"draft_plan"})` returns a `PhasePlan` parsed by `parsePhasePlan` (`src/domain/phase-plan.ts`). State transitions: `CLASSIFYING → DRAFT_PLAN → PLAN_GENERATED`.
5. **Design doc** (orchestrator-v2 line ~230) — only if `tierNeedsDesignDoc(tier)`. `dispatch({kind:"generate_design_doc"})`, written to `docs/design/<feature>.md` and to `run-artifacts/<runId>/design-doc.md`.
6. **Decompose** (`src/orchestrator/ticket-decomposer.ts::decomposePlanToTickets`) — calls `dispatch({kind:"decompose_tickets"})`, parses with `parseTicketPlan`, validates DAG with `validateTicketDag`, writes `run-artifacts/<runId>/ticket-ledger.json` and mirrors to `channels/<id>/tickets.json` via `ChannelStore.upsertChannelTickets`.
7. **Approval gate** (`src/orchestrator/approval-gate.ts::checkApproval`) — only if `tierNeedsApproval(tier)`. If not yet approved, persist run-index and return early. The CLI `rly approve <runId>` path resumes the run later by re-running `OrchestratorV2.run` against the same `runId`.
8. **Schedule** (`src/orchestrator/ticket-scheduler.ts::TicketScheduler.executeAll`) — drain ready tickets up to `maxConcurrency: 3`. For each ticket: `dispatch({kind:"implement_phase"})` (or `executor.start().wait()` if an `AgentExecutor` is wired), then `dispatch({kind:"run_checks"})` → `VerificationRunner.run()` → `dispatch({kind:"classify_failure"})` on non-zero exit → retry or mark failed. Status changes mirror to `channels/<id>/tickets.json` via `ChannelStore.upsertChannelTickets`. `RunEvent`s appended to the in-memory run.
9. **PR poller** (`src/integrations/pr-poller.ts::PrPoller`) — started by `OrchestratorV2.startPoller` if a `PollerFactory` was attached. Polls each tracked PR via `HarnessScm`, posts CI/review transitions to the channel feed, enqueues `fix-ci` / `address-reviews` follow-up tickets through `SchedulerFollowUpDispatcher`.
10. **Completion** — `OrchestratorV2.persistRunIndex(run)` writes `~/.relay/workspaces/<wsId>/run-index/<runId>.json`. `run_completed` feed entry posted. `RunState: COMPLETE` (or `FAILED` / `BLOCKED`).

### Session-State Path (the data path the upcoming token-usage telemetry will hook into)

This is the route that flows token usage / current-ticket / status from a
running coding-agent session back into the channel store.

1. **Agent CLI emits stream-json** — Claude / Codex print line-delimited JSON to stdout. For Claude this includes `system.init`, `tool_use`, `assistant.message`, and a final `result` event with usage counters (`input_tokens`, `output_tokens`, `cache_*`, `service_tier`, etc.).
2. **`NodeCommandInvoker.spawn`** (`src/agents/command-invoker.ts`) — yields each line to the registered observer. The Tauri backend (`gui/src-tauri/src/lib.rs`) does this via `BufReader` on the child stdout and emits a `chat-event` Tauri event per line.
3. **`CliAgent` parses lines** (`src/agents/cli-agents.ts`) — when `onStreamLine` is supplied, the adapter switches to `--output-format stream-json --verbose`. The final buffered `result` event is parsed into the `AgentResult` returned to the dispatcher. Today only `summary / evidence / proposedCommands / blockers / failureClassification / phasePlan` flow back; **token usage from `result.usage` is dropped**.
4. **Channel feed mirror** (`src/orchestrator/orchestrator-v2.ts::dispatch`) — every `dispatch` call posts an "agent dispatched" `message` entry via `ChannelStore.postEntry`, with `metadata: { attempt }`. The completion side writes a `status_update` (or no entry on success — see the dispatch fan-out around lines 488-540).
5. **Session transcript** (`src/cli/session-store.ts::appendChatMessage`) — for the chat-mode CLI (`rly chat`), each user/assistant turn is appended to `~/.relay/channels/<channelId>/sessions/<sessId>.jsonl` as a `PersistedChatMessage`. The `messageCount` index lives in `channels/<channelId>/sessions.json`.
6. **Dashboards re-render** — the Rust crate's `load_channel_feed` (`crates/harness-data/src/lib.rs:999`), `load_sessions` (line 1316), `load_session_chat` (line 1368) re-read those files on poll. The TUI re-reads on key/timer events; the Tauri GUI re-reads when a Tauri command is invoked or when the backend emits a `chat-event`.

**Hook point for token telemetry:** the bridge between (3) and (5) — the
adapter currently throws away `result.usage`. To plumb it into the channel
store, extend `AgentResult` (`src/domain/agent.ts`) with a `tokenUsage` field,
have `cli-agents.ts` populate it from the parsed `result` event, and have the
orchestrator's dispatch wrapper (`orchestrator-v2.ts:474`) carry it through
to a new `ChannelStore.recordSessionUsage(sessionId, usage)` that writes a
namespaced doc (proposed: `STORE_NS.session` already exists; add a
`session-usage` namespace or a `usage` field on the session index).

**State Management:**
- `HarnessRun` is the in-memory accumulator for an orchestrator run. It is mirrored to disk only at boundary points (`persistRunIndex`, ticket-ledger writes, artifact saves). On restart it is rehydrated from `~/.relay/workspaces/<wsId>/run-index/<runId>.json`.
- `Channel`, `ChannelEntry`, `Decision`, `TicketLedgerEntry`, `ChatSession`, `PersistedChatMessage` live entirely on disk — the orchestrator and dashboards read on demand. No process holds a long-lived `Channel` object.
- `HarnessStore.mutate(ns, id, fn)` provides per-key serialization — used wherever a read-modify-write would race (channel ticket upserts, session indices, run index updates). Cross-process safety arrives with `PostgresHarnessStore`.

## On-Disk State (`~/.relay/`)

| Path | Shape | Writers | Readers |
|------|-------|---------|---------|
| `channels/<id>.json` | One JSON doc per channel — manifest (name, members, repos, tier, kind, tracker links). Atomic tmp-rename. | `src/channels/channel-store.ts::writeChannel` | `crates/harness-data/src/lib.rs::load_channel`, GUI `Sidebar.tsx`, TUI `ui.rs`, MCP `channel_*` tools |
| `channels/<id>/feed.jsonl` | **Append-only JSONL** of `ChannelEntry`. Never rewritten. | `src/channels/channel-store.ts::postEntry` (and via orchestrator `dispatch` mirroring) | `crates/harness-data/src/lib.rs::load_channel_feed`, GUI `MessageList.tsx`, TUI |
| `channels/<id>/tickets.json` | One JSON doc — full `TicketLedgerEntry[]` for that channel. Atomic tmp-rename, serialized via `channelTicketLocks`. | `src/channels/channel-store.ts::upsertChannelTickets` (called by `TicketScheduler` + `OrchestratorV2.mirrorToChannelBoard`) | `crates/harness-data/src/lib.rs::load_channel_tickets`, GUI `BoardView.tsx`, TUI Board tab |
| `channels/<id>/decisions/<decId>.json` | One file per decision id. Atomic. | `src/channels/channel-store.ts::recordDecision` (also mirrored to `STORE_NS.decision` keyed `<channelId>:<decId>`) | `crates/harness-data/src/lib.rs::load_channel_decisions`, GUI `DecisionsView.tsx` |
| `channels/<id>/runs.json` | JSON list of `ChannelRunLink` (run-id ↔ workspace-id). | `src/channels/channel-store.ts::linkRun` | `crates/harness-data/src/lib.rs::load_channel_run_links` |
| `channels/<id>/sessions.json` | JSON index of `ChatSession` (sidebar list of chat sessions in a channel). | `src/cli/session-store.ts::SessionStore` | `crates/harness-data/src/lib.rs::load_sessions`, GUI `SessionList.tsx` |
| `channels/<id>/sessions/<sessId>.jsonl` | **Append-only** JSONL transcript of `PersistedChatMessage`. | `src/cli/session-store.ts::appendChatMessage` | `crates/harness-data/src/lib.rs::load_session_chat`, GUI `MessageList.tsx`, `chat-rewind` |
| `sections.json` | One bag file — sidebar groups. | `src/channels/section-store.ts` | `crates/harness-data/src/lib.rs::load_sections` |
| `workspace-registry.json` | Global registry of repo paths the user has registered. | `src/cli/workspace-registry.ts`, also `gui/src-tauri/src/lib.rs::auto_register_discovered` | `crates/harness-data/src/lib.rs::load_workspaces`, GUI repo picker |
| `workspaces/<wsId>/run-index/<runId>.json` | Per-workspace per-run index (state machine snapshot). | `OrchestratorV2.persistRunIndex`, `src/execution/artifact-store.ts` | `crates/harness-data/src/lib.rs::load_runs_for_workspace`, TUI Runs view |
| `workspaces/<wsId>/run-artifacts/<runId>/*` | Per-run artifact files (classification.json, plan.json, ticket-ledger.json, design-doc.md, command outputs). | `src/execution/artifact-store.ts::LocalArtifactStore` | `crates/harness-data/src/lib.rs::load_ticket_ledger`, GUI run viewer |
| `crosslink-session/<id>.json` | Per-session presence record (heartbeat, repo, kind). Atomic. | `src/crosslink/store.ts::CrosslinkStore` | Same; MCP `crosslink_*` tools, claude-code hook |
| `crosslink-mailbox/<to>__<msg>.json` | Per-message envelope. Sender writes, receiver reads + deletes. | `src/crosslink/store.ts::sendMessage` | `src/crosslink/store.ts::pollInbox` |
| `decision/<channelId>:<decId>.json` | Mirror of `channels/<id>/decisions/<decId>.json` under `HarnessStore` namespace, used for cross-namespace `listDocs(decision, <channelId>:)` enumeration. | `src/channels/channel-store.ts::recordDecision` | Same |
| `channel-tickets/<channelId>.json` | Coordination record (mutex doc) for `upsertChannelTickets`. | `src/channels/channel-store.ts` (via `store.mutate`) | Coordination only; not surfaced |
| `agent-name/<agentId>.json` | Persistent assigned-name cache so the same agent id keeps its display name across runs. | `src/domain/agent-names.ts::registerAgentNames` | `crates/harness-data/src/lib.rs::load_agent_names` |
| `sessions/<sessId>/session.json` + `lifecycle.json` | Per-running-claude-session metadata + lifecycle markers (used by autonomous loop + STOP-file watcher). | `src/cli/session-store.ts`, `src/lifecycle/session-lifecycle.ts` | TUI / GUI agent panes, `src/orchestrator/stop-file-watcher.ts` |
| `approvals/<sessId>/queue.jsonl` | Append-only queue of permission-prompt approvals (AL-7). | `src/approvals/queue.ts` | TUI / GUI approval drawers (`crates/harness-data/src/lib.rs::load_approval_queue`) |
| `provider-profiles.json` | Bag of provider profiles (adapter, model, env overlay). | `src/storage/provider-profile-store.ts` | Channel header pill, agent factory |
| `gui-settings.json` | Tauri GUI preferences. | `gui/src-tauri/src/lib.rs` | Same |
| `config.env` | User secrets file (chmod 600). Sourced by the user's shell, **never read by Relay code**. | `src/cli/welcome.ts` (templated on first run) | The user's shell |
| `installed.json`, `onboarded.json`, `config.json`, `gui-settings.json` | Top-level scalar JSON used by install / welcome / project-dir discovery. | `src/cli/install.ts`, `src/cli/welcome.ts`, `src/cli/config.ts` | Each respective subsystem |

## Three-Views-One-Source-of-Truth Contract

The CLI dashboard, Rust TUI, and Tauri GUI never coordinate at runtime. Each
process re-reads `~/.relay/` whenever it needs to render. The contract is:

- **Schema authoritative on the TS side.** `src/domain/*.ts` defines the
  shapes. Any change to a type that lives on disk must be mirrored in
  `crates/harness-data/src/lib.rs` in the same PR (see AGENTS.md
  "Cross-dashboard contract"). Required-field additions without a Rust
  update silently break TUI/GUI parsing — symptom is rows missing or empty.
- **Rust crate is read-mostly.** `harness-data` exposes `load_*` functions;
  it has a few `save_*` helpers (`save_channel`, `save_gui_settings`,
  `register_workspace`) that the GUI uses, all going through the same
  atomic-write helper.
- **TUI** (`tui/src/main.rs`) shells out to `rly` via `cli_json` for
  state-mutating actions and reads via `harness_data` for display. It is a
  pure ratatui app driven by crossterm events and a polling timer.
- **Tauri GUI** (`gui/src-tauri/src/lib.rs`) exposes Tauri commands that
  delegate to `harness_data` for reads, and to spawning `rly` subprocesses
  (or directly to `harness_data::save_*`) for writes. The React frontend
  (`gui/src/App.tsx`) calls these via `@tauri-apps/api/core::invoke`.
- **Watch / re-render strategy:** TUI polls on a ratatui tick; GUI re-fetches
  per-Tauri-command + listens for `chat-event` events emitted from
  `gui/src-tauri/src/lib.rs` while a child agent is streaming. CLI
  subcommands run-and-exit; there is no long-lived CLI render.

## Key Abstractions

**`HarnessRun`** (`src/domain/run.ts`):
- Represents one orchestrator run end-to-end. State machine in `src/domain/state-machine.ts::assertTransition`.
- Mutated in memory by `OrchestratorV2`; mirrored to `~/.relay/workspaces/<wsId>/run-index/<runId>.json`.

**`Channel`** (`src/domain/channel.ts`):
- The chat surface around a body of work. Many runs can be linked to one channel via `channels/<id>/runs.json`. Owns its own ticket board, feed, decisions, sessions.

**`TicketLedgerEntry` / `TicketDefinition`** (`src/domain/ticket.ts`):
- One unit of parallelizable work. `dependsOn` edges form the DAG that the scheduler drains.

**`Agent` / `AgentRegistry` / `WorkRequest`** (`src/domain/agent.ts`, `src/agents/registry.ts`):
- `Agent.capability.role` is `planner` / `tester` / `coder` / `general`. `roleForWork(workKind)` maps a request to a role; the registry picks the highest-scoring agent that supports it (specialty match adds 20, `general` capability adds 5).

**`AgentExecutor` / `ExecutionHandle` / `SandboxRef`** (`src/execution/executor.ts`, `src/execution/sandbox.ts`):
- Newer alternative to dispatch-callback: model the lifecycle of a child process explicitly so the scheduler can `start → wait → kill`. Used by `LocalChildProcessExecutor` with `GitWorktreeSandboxProvider`.

**`HarnessStore`** (`src/storage/store.ts`):
- Three primitives: docs (full-overwrite), logs (append-only), blobs (opaque bytes), plus `mutate` (atomic RMW) and `watch` (change events). Two impls share the interface; `factory.ts::buildHarnessStore` selects via `HARNESS_STORE_BACKEND`.

**`MCP tool`** (`src/mcp/server.ts`):
- A function the running coding-agent CLI can call back into Relay with. Categories: `channel_*`, `crosslink_*`, `coordination_*`, `pr_review_*`. Tool contracts lived in their respective `*-tools.ts` modules.

## Entry Points

**`bin/rly.mjs`** — Node launcher.
- Triggers: `rly …` from the user's shell, the GUI's "spawn agent" path, install.sh, MCP host.
- Resolves `tsx` from `node_modules/.bin/tsx` and execs `src/cli.ts`. `RELAY_USE_DIST=1` short-circuits to `dist/cli.js`.

**`src/cli.ts`** — TS entry.
- Calls `main()` from `src/index.ts`, prints any thrown error, sets `process.exitCode = 1`.

**`src/index.ts::main`** — top-level command dispatcher.
- ~3500 lines, mostly an `if (command === "...") return …` chain. Subcommands include: `up`, `status`, `list-runs`, `list-workspaces`, `inspect-mcp`, `doctor`, `config`, `providers`, `session`, `chat`, `dashboard`, `tui`, `gui`, `rebuild`, `install`, `welcome`, `channels`, `channel`, `section`, `running`, `board`, `decisions`, `crosslink`, `pr-watch`, `pr-status`, `sweep-worktrees`, `approve`, `reject`, `pending-plans`, `pending-approvals`, `mcp-server`, `serve`, `claude`, `codex`, `run`.

**`tui/src/main.rs`** — Rust ratatui binary, launched by `rly tui`.
**`gui/src-tauri/src/lib.rs`** — Tauri backend, launched as `Relay.app` or `rly gui`.
**`src/mcp/server.ts::startMcpServer`** — stdio MCP server (default; one per running coding-agent session). HTTP variant in `src/mcp/http-transport.ts` invoked by `rly serve`.

## Architectural Constraints

- **Threading:** Single-threaded Node event loop on the TS side. Concurrency is `Promise.all` + a hand-rolled scheduler with `maxConcurrency: 3`. The Rust TUI uses one event thread + one timer thread (`tui/src/main.rs::mpsc`). The Tauri backend uses Tokio with per-stream reader threads.
- **Cross-process locking:** None on the file backend — `FileHarnessStore` is single-process by design. Multi-writer scenarios (autonomous loop + `rly run` simultaneously) require `PostgresHarnessStore`. In-process coordination uses `Promise`-tail mutex maps (`channelTicketLocks`, `prUrlLocks`, `keyLocks`).
- **Global state:** `getRelayDir()` caches the resolved `~/.relay/` path for the process lifetime (`src/cli/paths.ts`). `buildHarnessStore()` returns a process-wide singleton via `src/storage/factory.ts`. `__resetRelayDirCacheForTests` and the `FakeHarnessStore` in `test/` are how tests escape it.
- **Subprocess env is sanitized.** `NodeCommandInvoker` strips secrets-by-pattern before spawning any child (`src/agents/command-invoker.ts::SECRET_NAME_PATTERN`). Adapters opt-in extra vars via `passEnv`.
- **No partial writes.** Every doc under `~/.relay/` is tmp-file + rename. `feed.jsonl` and `queue.jsonl` are append-only — never rewritten.
- **Disk wins.** `HarnessStore` writes are mirrored to an in-memory coordination layer for `LISTEN/NOTIFY`, but if memory and disk disagree, disk wins on the next read.
- **Process boundary at the agent CLI.** Relay never imports the Anthropic / OpenAI SDK directly; it spawns `claude` / `codex` and parses their stdout. This is the OSS provider-agnostic story.

## Anti-Patterns

### Rewriting `feed.jsonl` in place

**What happens:** A new write path tries to "fix" or "edit" a previously posted feed entry by overwriting `feed.jsonl`.
**Why it's wrong:** The feed is append-only by contract (AGENTS.md "File-safety expectations"). The Rust crate streams it; rewriting causes torn reads in the GUI and breaks the rewind feature, which expects monotonic history.
**Do this instead:** Post a correction entry (`type: "status_update"` or a new entry type) — see `src/channels/channel-store.ts::postEntry`. History stays intact.

### Reading `~/.relay/` from a hot path without caching the path

**What happens:** A new helper calls `join(homedir(), ".relay", ...)` directly.
**Why it's wrong:** `getRelayDir()` (`src/cli/paths.ts`) is the single resolver — it ensures the dir exists, caches the result, and respects `RELAY_HARNESS_ROOT` test override (Rust mirror at `crates/harness-data/src/lib.rs::harness_root`).
**Do this instead:** `import { getRelayDir } from "../cli/paths.js"` and join under it.

### Branching on store backend at the call site

**What happens:** `if (process.env.HARNESS_STORE_BACKEND === "postgres") …`
**Why it's wrong:** `HarnessStore` is the abstraction. Backend selection lives in `src/storage/factory.ts::buildHarnessStore`. Branching at the call site spreads backend-specific assumptions into business logic.
**Do this instead:** Add the capability to the `HarnessStore` interface (or to `mutate`-style RMW), implement on both backends, call uniformly.

### Mutating `process.env` from inside an AO plugin

**What happens:** `tracker.ts` or `scm.ts` poke `process.env.GITHUB_TOKEN = ...` directly.
**Why it's wrong:** Plugin loading already has a non-reentrant env mutex (`src/integrations/plugin-env-mutex.ts::withEnvOverride`); two concurrent callers corrupt each other's snapshot.
**Do this instead:** Wrap the load in `withEnvOverride({ ... }, async () => …)`.

### Synchronously fanning out a channel write inside a `dispatch` callback

**What happens:** `await channelStore.postEntry(...)` blocks the orchestrator dispatch path.
**Why it's wrong:** The orchestrator already has best-effort fan-out via `trackChannelPost(run, ...)` (`src/orchestrator/orchestrator-v2.ts`). Synchronous awaits in dispatch couple agent latency to channel I/O.
**Do this instead:** Fire-and-track via `trackChannelPost` — the run drains pending writes before resolving.

## Error Handling

**Strategy:** Layered. The orchestrator's outer loop is best-effort: a failed channel post or a failed PR-poller start logs a warning and continues; only the run-state-machine transition errors are hard. Agent failures are routed through `failure-routing.ts` (`buildRetryContext`, `buildRetryObjective`) and become retries; structurally bad results (verification plan missing, ticket DAG cyclic) become hard fails on the run.

**Patterns:**
- Wrap I/O that can race teardown in `try/catch`, push the promise onto `pendingWrites`, await it before `run()` returns. (`src/orchestrator/orchestrator-v2.ts`, `src/orchestrator/ticket-scheduler.ts`).
- Map executor `start()` / `wait()` rejections into `AgentResult.blockers` so the existing retry machinery handles them (`src/orchestrator/ticket-scheduler.ts::buildExecutorDispatch`).
- "Log-and-continue on best-effort writes" comment marker — used at every channel-mirror call site.

## Cross-Cutting Concerns

**Logging:** `console.warn` / `console.error` to stderr. No structured logger. The orchestrator prefixes its lines `[orchestrator]`; the scheduler uses `[scheduler]`. The MCP server emits JSON-RPC responses on stdout — anything that goes to stdout in `mcp-server` mode breaks the protocol, which is why every diagnostic is `console.error`.

**Validation:** Zod schemas live in `src/domain/*.ts` next to their TS types (`ChannelStatusSchema`, `ProviderProfileAdapterSchema`, `AgentResultSchema`, etc.). LLM-returned JSON is parsed with `parsePhasePlan`, `parseTicketPlan`, `parseClassificationResult` — strict zod parses, with a custom error so the orchestrator can retry the dispatch on a malformed plan.

**Authentication:**
- Coding agents auth themselves (Claude via stored config dir / `claude setup-token`, Codex via `codex login`). Relay never holds those tokens; it just opts the relevant env vars through `CLAUDE_PASS_ENV` / `CODEX_PASS_ENV` (`src/agents/cli-agents.ts`).
- GitHub: `GITHUB_TOKEN` from `~/.relay/config.env`, exec'd via `gh` shell-out in `src/integrations/scm.ts`.
- Linear: `LINEAR_API_KEY` from same file, used in `src/integrations/linear-mirror.ts`.
- MCP `rly serve` requires `--token` for non-loopback binds (`src/mcp/serve-validation.ts`).

---

*Architecture analysis: 2026-05-09*
