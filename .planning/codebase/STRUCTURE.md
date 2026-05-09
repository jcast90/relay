# Codebase Structure

**Analysis Date:** 2026-05-09

## Directory Layout

```
agent-harness/
├── bin/
│   └── rly.mjs              # CLI launcher: tsx → src/cli.ts (or dist/cli.js if RELAY_USE_DIST=1)
├── src/                     # TypeScript orchestrator + CLI + MCP server
│   ├── cli.ts               # Entry point (called by bin/rly.mjs)
│   ├── index.ts             # main(): argv parse + ~50 subcommand dispatch
│   ├── cli/                 # Subcommands, launchers, paths, workspace bootstrap
│   ├── orchestrator/        # classifier → planner → decomposer → scheduler → approval
│   ├── agents/              # Claude/Codex CLI adapters, registry, command invoker
│   ├── channels/            # ChannelStore: feed/decisions/tickets/runs/sessions on disk
│   ├── execution/           # AgentExecutor, sandbox, verification-runner, artifact-store
│   ├── storage/             # HarnessStore interface + file & postgres backends
│   ├── integrations/        # tracker / scm / pr-poller / linear-mirror / github-projects
│   ├── mcp/                 # MCP JSON-RPC server, tool definitions, role allowlist
│   ├── crosslink/           # Cross-session messaging (mailboxes), claude-code hook
│   ├── simulation/          # ScriptedInvoker (default invoker when HARNESS_LIVE unset)
│   ├── domain/              # Shared TS types + zod schemas (mirrored in Rust crate)
│   ├── lifecycle/           # Session-lifecycle markers + types
│   ├── approvals/           # Permission-prompt approval queue (AL-7)
│   ├── budget/              # token-tracker.ts (cost / budget enforcement scaffolding)
│   ├── install/             # installer.ts + manifest.ts (rly install)
│   └── tui/                 # Thin TS shim that launches tui/ ratatui binary
├── tui/                     # Rust ratatui dashboard
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs          # ratatui app + crossterm event loop
│       ├── ui.rs            # Layout + render functions
│       └── install_drift.rs # Footer banner reading rly install --check
├── gui/                     # Tauri desktop app
│   ├── package.json         # React + Vite frontend
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── src/                 # Frontend (React)
│   │   ├── App.tsx          # Root component (Sidebar / CenterPane / RightPane)
│   │   ├── main.tsx         # React entry
│   │   ├── api.ts           # Tauri-command wrappers
│   │   ├── types.ts         # Frontend-only shapes (most types come from harness-data via IPC)
│   │   ├── components/      # Channel UI components (one .tsx per concept)
│   │   ├── lib/             # Helpers (mentions, dialogs, channel ops, appearance, agents)
│   │   └── styles/, styles.css
│   └── src-tauri/           # Tauri backend (Rust)
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── capabilities/    # Tauri capability manifests
│       └── src/
│           ├── main.rs
│           └── lib.rs       # All Tauri commands; spawn-agent terminal launcher lives here
├── crates/
│   └── harness-data/        # Shared Rust crate read by tui/ + gui/src-tauri/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs       # Channel / Decision / Ticket / Run shapes + load_* readers
│           └── tool_activity.rs
├── test/                    # vitest, mirrors src/
├── scripts/                 # Build / seed / sync helpers (.mjs and .ts)
├── agent_docs/              # Agent-targeted reference (architecture.md, data-model.md, testing.md)
├── docs/                    # Human-targeted docs incl. design/ design docs
├── dist/                    # Compiled JS output (tsc -p tsconfig.build.json)
├── target/                  # Rust build artifacts (gitignored)
├── node_modules/            # gitignored
├── .planning/               # GSD planning artifacts (this file lives under codebase/)
├── .claude/                 # Claude Code project config
├── .changeset/              # Changesets for npm releases
├── .github/                 # CI workflows (.github/workflows/ci.yml + integration.yml)
├── package.json             # Root workspace package
├── pnpm-lock.yaml
├── Cargo.toml               # Cargo workspace root (members: tui, gui/src-tauri, crates/*)
├── Cargo.lock
├── tsconfig.json            # Editor / vitest config
├── tsconfig.build.json      # Production build config (drives dist/)
├── vitest.config.ts
├── .prettierrc, .prettierignore
├── install.sh               # One-line installer
├── AGENTS.md                # Coding-agent conventions (the source of truth)
├── CLAUDE.md                # Pointer to AGENTS.md
├── CONTRIBUTING.md          # Human contributor guide
├── README.md                # Product README
├── ROADMAP.md, CHANGELOG.md, CI.md, SECURITY.md, CODE_OF_CONDUCT.md, LICENSE
└── llms.txt                 # llms.txt manifest
```

## Top-Level Layout

- **`bin/`** — single Node launcher (`rly.mjs`). Anything user-facing starts here.
- **`src/`** — the TypeScript orchestrator. This is where most behaviour lives. Treat the subdirectories as layers (CLI / orchestrator / agents / channels / execution / storage / integrations / mcp / crosslink / simulation / domain). They depend roughly inward: `cli` and `mcp` use `orchestrator`, which uses `agents` + `execution` + `channels`, which use `storage` + `domain`.
- **`tui/`** — Rust ratatui binary. Read-only against `~/.relay/` (mutating actions shell out to `rly`).
- **`gui/`** — Tauri desktop app. React frontend in `gui/src/`, Rust backend in `gui/src-tauri/`. Shares `crates/harness-data/` with the TUI.
- **`crates/harness-data/`** — the shared Rust crate. Both `tui/` and `gui/src-tauri/` depend on it. **Any disk-shape change in `src/domain/` must be mirrored here in the same PR.**
- **`test/`** — vitest tree, mirrors `src/`. One test file per source file is the norm.
- **`scripts/`** — one-off ops scripts (push tickets to GitHub, seed loops, sync versions, copy migrations).
- **`agent_docs/`** — agent-targeted deep references. Grep here when AGENTS.md doesn't answer a question.
- **`docs/`** — human-targeted (`getting-started.md`, `design/<feature>.md`, etc.). Design docs live under `docs/design/`.
- **`dist/`** — compiled output. Gitignored. Only material to users running with `RELAY_USE_DIST=1`.

## What Lives Where in `src/`

**`src/cli/`** — argv-parse-time concerns and subcommand launchers.
- `paths.ts` — `getRelayDir()`, the only resolver for `~/.relay/`. Use this, not `homedir() + ".relay"`.
- `workspace.ts` / `workspace-registry.ts` — per-workspace `.relay/` bootstrap and the global `~/.relay/workspace-registry.json` writer.
- `launcher.ts` — interactive command launchers used by `rly claude` / `rly codex`.
- `launch-gui-tui.ts` — flag parsing + spawn for `rly tui` / `rly gui`.
- `rebuild.ts` — `rly rebuild` (also rebuilds Rust bins on `--tui` / `--gui`).
- `welcome.ts`, `install.ts`, `update-nudge.ts`, `pr-watcher-factory.ts`, `chat-context.ts`, `chat-rewind.ts`, `session-store.ts`, `agent-wrapper.ts`, `stream-activity-renderer.ts`, `config.ts`, `run-autonomous.ts`.

**`src/orchestrator/`** — pipeline stages, in execution order:
- `classifier.ts` — heuristic + LLM tier classification.
- `dispatch.ts` — single-call agent dispatch surface (used by tests, `rly run`, MCP `dispatch` tool).
- `orchestrator.ts` / `orchestrator-v2.ts` — drive a run end-to-end. v2 is the current path; v1 is kept for back-compat.
- `ticket-decomposer.ts` — phase plan → ticket DAG.
- `ticket-scheduler.ts` — DAG drain + retry + verification.
- `ticket-router.ts`, `ticket-runner.ts` — supporting helpers for the autonomous-loop path.
- `approval-gate.ts` — wait-for-approval boundary.
- `failure-routing.ts` — retry-context builders, recoverable / non-recoverable classification.
- `autonomous-loop.ts` — long-running multi-run driver (`rly run --autonomous`).
- `repo-admin-pool.ts`, `repo-admin-session.ts` — long-lived MCP-only repo-admin sessions.
- `worker-spawner.ts`, `worktree-sweep.ts`, `audit-agent.ts`, `session-summary.ts`, `stop-file-watcher.ts`.

**`src/agents/`** — provider plumbing.
- `cli-agents.ts` — `ClaudeCliAgent` + `CodexCliAgent` (extend `CliAgentBase`); know how to spawn the right binary, parse the right output, and toggle stream-json mode.
- `command-invoker.ts` — `NodeCommandInvoker.exec` / `.spawn`, the env-sanitization layer.
- `registry.ts` — role/specialty matcher.
- `factory.ts` — production wiring (`createLiveAgents`).
- `provider-profile-lookup.ts` — resolve a channel's provider profile id to its env overlay.
- `repo-admin.ts` — repo-admin tool stubs + `spawnWorkerStub`.

**`src/channels/`** — `~/.relay/channels/` owner.
- `channel-store.ts` — the canonical writer. Anything that touches a channel file goes through here.
- `section-store.ts` — sidebar grouping (`sections.json`).
- `board-resolver.ts` — "which board to show for this channel" logic.
- `ao-notifier.ts` — bridge to the cross-process notifier (LISTEN/NOTIFY surface).

**`src/execution/`** — sandbox + checks.
- `executor.ts` — `AgentExecutor` interface + `ExecutionHandle` lifecycle.
- `local-child-process-executor.ts` — production impl.
- `noop-executor.ts` — for tests and the legacy dispatch path.
- `sandbox.ts` + `sandboxes/git-worktree.ts` — `SandboxRef` + git-worktree provider.
- `verification-runner.ts` — run allowlisted commands, write artifacts.
- `artifact-store.ts` — `LocalArtifactStore` (`run-artifacts/<runId>/...`).

**`src/storage/`** — generic persistence.
- `store.ts` — interface (`getDoc/putDoc/listDocs/deleteDoc/appendLog/readLog/putBlob/getBlob/mutate/watch`).
- `file-store.ts` — `FileHarnessStore` (default).
- `postgres-store.ts` — `PostgresHarnessStore` (multi-writer).
- `factory.ts` — `buildHarnessStore()` singleton.
- `namespaces.ts` — `STORE_NS` constants.
- `migrations/` — Postgres DDL + a migration runner.
- `provider-profile-store.ts` — provider-profile bag.

**`src/integrations/`** — external plugins (the "AO" — Agent Orchestrator — plugin family).
- `tracker.ts` — `HarnessTracker` interface + GitHub Issues impl.
- `linear-mirror.ts` — Linear → channel ticket mirror.
- `github-projects/` — GitHub Projects sync (`client.ts`, `sync-worker.ts`, `channel-hooks.ts`, `draft-items.ts`, `fields.ts`, `url-parser.ts`).
- `scm.ts` — `HarnessScm` (`gh` shell-out for PR ops).
- `pr-poller.ts` — `PrPoller` watches tracked PRs.
- `pr-reviewer.ts` — review-fetch helper.
- `scheduler-follow-up-dispatcher.ts` — bridge from poller events to scheduler enqueue.
- `plugin-env-mutex.ts` — `withEnvOverride` (non-reentrant env mutator).

**`src/mcp/`** — JSON-RPC tools surface.
- `server.ts` — request handler + tool dispatch.
- `channel-tools.ts`, `coordination-tools.ts`, `pr-review-tool.ts` — tool definitions.
- `role-allowlist.ts` — per-role tool allow/deny.
- `serve-validation.ts` — `rly serve` security checks (loopback / token / `--allow-unauthenticated-remote`).
- `http-transport.ts` — HTTP shim used by `rly serve`.

**`src/crosslink/`** — cross-session messaging.
- `store.ts` — `CrosslinkStore` (sessions + mailboxes).
- `coordinator.ts` — orchestrates the messaging surface.
- `cli.ts` — `rly crosslink …` subcommand handler.
- `tools.ts` — MCP tool definitions.
- `hook.ts` — claude-code hook payload generator.
- `messages.ts`, `types.ts`, `ipc-bridge.ts`, `ipc-paths.ts`.

**`src/domain/`** — types + schemas. **One file per concept.** No business logic.
- `agent.ts`, `agent-names.ts`, `channel.ts`, `classification.ts`, `decision.ts`, `phase-plan.ts`, `pr-lifecycle.ts`, `pr-row.ts`, `provider-profile.ts`, `run.ts`, `session.ts`, `specialty.ts`, `state-machine.ts`, `ticket.ts`, `tier-mapper.ts`, `tool-activity.ts`, `tracker-config.ts`.

**`src/simulation/`** — `scripted-invoker.ts`. The default invoker when `HARNESS_LIVE` is unset.

**`src/lifecycle/`** — session-lifecycle markers (autonomous-loop bookkeeping).

**`src/approvals/`** — permission-prompt approval queue.
- `index.ts`, `queue.ts` — `~/.relay/approvals/<sessionId>/queue.jsonl` writer/reader.
- `trust-gate.ts` — pre-approval policy.

**`src/budget/`** — `token-tracker.ts` (cost / budget guardrails — sparse today; the natural landing spot for the upcoming token-usage telemetry feature).

**`src/install/`** — `installer.ts`, `manifest.ts` (rly install).

**`src/tui/`** — `dashboard.ts`. A thin TS shim that calls into the ratatui binary.

## What Lives in `tui/` (Rust)

- `tui/Cargo.toml` — binary crate, depends on `harness-data` (path), `ratatui`, `crossterm`.
- `tui/src/main.rs` — app state, event loop (crossterm events on one thread, polling timer on another via `mpsc::channel`), key bindings, tab routing (`Chat | Board | Decisions`), shells out to `rly` for mutating actions via `cli_json` (`Command::new(cli_bin())`).
- `tui/src/ui.rs` — layout / render functions (split sidebar / center / right; per-tab body).
- `tui/src/install_drift.rs` — drift-banner helper that runs `rly install --check`.

## What Lives in `gui/`

**Frontend (`gui/src/`)** — React 18 + Vite + TypeScript.
- `App.tsx` — root layout. Three-pane shell (Sidebar / CenterPane / RightPane).
- `main.tsx` — React + Vite entry.
- `api.ts` — Tauri-command wrappers (typed `invoke<T>(...)` calls).
- `types.ts` — frontend-only shapes (most types are derived from harness-data via Tauri command return types).
- `test-setup.ts` — vitest setup for the GUI (jsdom).
- `components/` — one `.tsx` per UI concept:
  - Layout: `Sidebar.tsx`, `CenterPane.tsx`, `RightPane.tsx`, `ChannelHeader.tsx`, `DmHeader.tsx`.
  - Chat: `MessageList.tsx`, `Composer.tsx`, `SessionList.tsx`.
  - Boards: `BoardView.tsx`, `DecisionsView.tsx`, `RepoChipRow.tsx`.
  - Modals / drawers: `NewChannelModal.tsx`, `NewDmModal.tsx`, `PromoteDmModal.tsx`, `PromptModal.tsx`, `ChannelSettingsDrawer.tsx`, `SettingsPage.tsx`.
  - Specialised: `AutonomousSessionHeader.tsx`, `SpinoutSuggestion.tsx`, `UpdateBanner.tsx`.
  - Tests sit next to their components (`Sidebar.test.tsx`, etc.).
- `lib/` — helpers: `mentions.tsx`, `dialogs.ts`, `channel.ts`, `appearance.ts`, `agents.ts`, `alias.ts`, `firstRun.ts`.
- `styles/` + `styles.css` — global styles.

**Backend (`gui/src-tauri/`)** — Rust + Tauri 2.
- `Cargo.toml` — depends on `tauri`, `harness-data` (path), `serde`, `dirs`.
- `tauri.conf.json` — Tauri config.
- `capabilities/` — Tauri capability manifests.
- `build.rs` — Tauri build script.
- `src/main.rs` — entry (`tauri::Builder` setup, registers commands from `lib.rs`).
- `src/lib.rs` — every Tauri command. Notable surfaces:
  - All channel CRUD / read commands delegating to `harness_data::*`.
  - `spawn_agent` — opens a terminal tab in the user's preferred terminal app for the channel's repo (macOS osascript / Linux x-terminal-emulator chain / Windows wt.exe → powershell → cmd).
  - `augmented_child_path()` / `resolve_rly_bin` — Finder-launched-app PATH compensation.
  - Chat-event streaming via `app_handle.emit("chat-event", ...)`.

## Naming Conventions

**Files (TypeScript):** `kebab-case.ts`. Test files mirror with `.test.ts`. One concept per file.
- `channel-store.ts` (singular noun, not `ChannelStore.ts`).
- `cli-agents.ts` (not `CLIAgents.ts`).
- `pr-poller.ts` (not `PRPoller.ts` or `pr_poller.ts`).
- React components in the GUI use `PascalCase.tsx` because they export a default React component (e.g. `Sidebar.tsx`, `BoardView.tsx`).

**Files (Rust):** `snake_case.rs`. (`tool_activity.rs`, `install_drift.rs`.)

**Directories:** `kebab-case` everywhere (`crates/harness-data/`, `src/orchestrator/`, `gui/src-tauri/`, `src/integrations/github-projects/`).

**Types:** `PascalCase` (`ChannelStore`, `AgentResult`, `TicketScheduler`).

**Functions / variables:** `camelCase` (`buildChannelId`, `mirrorToChannelBoard`).

**Constants:** `UPPER_SNAKE_CASE` for module-level immutables (`STORE_NS`, `CLAUDE_PASS_ENV`, `WAKE_SENTINEL`, `MAILBOX_ID_SEPARATOR`).

**Zod schemas:** `<TypeName>Schema` paired with the type (e.g. `ChannelStatusSchema`/`ChannelStatus`).

**ID prefixes (stable):**
- `ch-…` channel ids (newer) / `channel-…` (older). Both shapes coexist; the Rust crate accepts both.
- `sess-<ms>` chat session ids (`buildSessionId`).
- `auto-<ms>-<rand>` autonomous-loop session ids.
- `tui-<ms>` TUI-originated entry ids.
- `dec-…` decision ids.
- `tk-…` ticket ids.
- `<basename>-<sha256[..12]>` workspace ids (canonical form).
- `discovered:<name>` workspace ids (transient — registered before validation).

**Cargo crates:** `harness-data` (kebab) crate name → `harness_data` import alias.

**File-layout convention on disk:** singular for single-doc namespaces (`session/<id>.json`, `decision/<id>.json`), plural for collection directories (`channels/<id>/...`, `workspaces/<id>/...`, `sessions/<id>/...`).

## Where to Add New Code

**A new orchestrator pipeline stage** (e.g. "review-bot pre-pass" between approval and scheduling):
- Add the stage as a new module under `src/orchestrator/<stage-name>.ts`, exporting a single function that takes `{ run, ... }` and returns whatever the next stage needs.
- Wire it into `OrchestratorV2.run` (`src/orchestrator/orchestrator-v2.ts`) at the right boundary point. Add a `RunEventType` if you want it to show up in the event log (`src/domain/run.ts`).
- If the stage emits a new artifact, extend `LocalArtifactStore` (`src/execution/artifact-store.ts`).
- If the stage adds disk state, define the namespace in `src/storage/namespaces.ts`, mirror the read in `crates/harness-data/src/lib.rs`.
- Tests under `test/orchestrator/<stage-name>.test.ts` using `ScriptedInvoker`.

**A new external integration** (new tracker, new SCM, new monitoring webhook):
- Add a module under `src/integrations/<integration-name>.ts` (or a subdirectory if it has multiple files, like `src/integrations/github-projects/`).
- If it shells out, route through `NodeCommandInvoker` (`src/agents/command-invoker.ts`); never `child_process.spawn` directly — the env sanitization is load-bearing.
- If it mutates `process.env`, use `withEnvOverride` (`src/integrations/plugin-env-mutex.ts`).
- Wire it into the CLI bootstrap in `src/index.ts` (the integration set is constructed there per command). For the PR-poller surface specifically, attach via `OrchestratorV2.attachPoller`.

**A new MCP tool:**
- Add a tool definition in the appropriate `src/mcp/<category>-tools.ts` (or create a new `<category>-tools.ts` if the surface is new).
- Register it in `src/mcp/server.ts::buildMcpMessageHandler`.
- Update the README's MCP tool list and `rly inspect-mcp` (the latter is authoritative — people grep README counts).
- Add to `src/mcp/role-allowlist.ts` if any role should be denied access.

**A new channel-related concept** (e.g. a new entry type, a new ticket field):
- Define the type + zod schema in `src/domain/channel.ts` / `src/domain/ticket.ts` / `src/domain/decision.ts`.
- Mirror the shape in `crates/harness-data/src/lib.rs` in the same PR. **Required.** Skipping this silently breaks TUI/GUI.
- Add the writer to `src/channels/channel-store.ts`.
- Update the README's `~/.relay/` file-layout tree if you added a new file or directory.

**A new CLI subcommand:**
- Add an `if (command === "<name>") { … return; }` block in `src/index.ts::main` (alphabetical within its rough section is fine; this file is long but flat by design).
- Print help inside the same handler if `args[0] === "--help"`.
- If the subcommand is non-trivial, factor the body into `src/cli/<name>.ts` and call from the if-block.
- Add to `printTopLevelHelp()` in the same file.

**A new dashboard view** (new tab in TUI, new page in GUI):
- TUI: extend the `Tab` enum in `tui/src/main.rs`, add render arm in `tui/src/ui.rs`, key binding in `main.rs`. Reads via `harness_data::load_*` only — no CLI shell-out for read paths.
- GUI: add a component under `gui/src/components/`, route from `App.tsx` or `Sidebar.tsx`, expose a Tauri command in `gui/src-tauri/src/lib.rs` if a new read shape is needed.

**A new HarnessStore namespace:**
- Add the constant to `src/storage/namespaces.ts`.
- If the data needs to live on disk in the channels-layout (`channels/<id>/...`), add the writer to `src/channels/channel-store.ts` and the reader to the Rust crate. Otherwise the default `FileHarnessStore` layout under `~/.relay/<ns>/<id>.json` is fine and Rust may not need to know about it.
- Postgres backend: extend the migration in `src/storage/migrations/` if the namespace deserves its own table (otherwise it lands in the generic doc table).

**A new test fixture / helper:** under `test/fixtures/` or `test/<area>/_helpers.ts`. **Never touch the real `~/.relay/`** — use a per-test tmp dir and pass it into `ChannelStore` / `FileHarnessStore` ctors.

## Special Directories

**`~/.relay/`** (NOT in the repo):
- Purpose: User's global Relay state.
- Generated: Yes (by `getRelayDir()` on first use; templated by `welcome.ts`).
- Committed: Never. Test code must use a tmp dir and never `rm -rf` outside it.

**`dist/`**:
- Purpose: Compiled JS output of `tsc -p tsconfig.build.json`.
- Generated: Yes (`pnpm build` / `rly rebuild`).
- Committed: No (gitignored).

**`target/`**:
- Purpose: Cargo build artifacts.
- Generated: Yes.
- Committed: No (gitignored).

**`node_modules/`**:
- Purpose: pnpm-resolved deps.
- Committed: No.

**`.changeset/`**:
- Purpose: Changesets for npm release (one md file per upcoming release note).
- Committed: Yes.

**`.planning/codebase/`** (this directory):
- Purpose: GSD codebase maps (ARCHITECTURE.md, STRUCTURE.md, etc.).
- Generated: Yes (by `/gsd-map-codebase`).
- Committed: Yes — they get loaded by `/gsd-plan-phase` and `/gsd-execute-phase`.

**`agent_docs/`**:
- Purpose: Reference docs targeted at coding agents working in the repo.
- Committed: Yes. `architecture.md`, `data-model.md`, `testing.md`, `repo-admin.md`, `tidewater_handoff/`.

---

*Structure analysis: 2026-05-09*
