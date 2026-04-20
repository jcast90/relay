<p align="center">
  <img src="gui/src-tauri/icons/icon.svg" alt="Relay" width="96" height="96"/>
</p>

# Relay

Local-first orchestration for phase-driven coding with Claude and Codex adapters. Classifies requests by complexity, decomposes work into parallelizable tickets, and executes them with verification loops.

CLI: `rly` (the legacy `agent-harness` command is kept as an alias so existing scripts keep working).

## Install

### One command (recommended)

```bash
./install.sh
```

Add `--with-tui` or `--with-gui` to also build the Rust dashboards. Use `--skip-link` to avoid `pnpm link --global` (useful in CI or on shared machines).

The installer checks prereqs (`node >=20`, `pnpm`, `git`, plus `cargo` if you asked for TUI/GUI), runs `pnpm install && pnpm build`, links the `rly` binary on your `$PATH`, and scaffolds `~/.relay/config.env.template`. It's safe to re-run.

If you've previously installed the tool under the `agent-harness` name, the installer auto-migrates `~/.agent-harness/` → `~/.relay/` and leaves a back-compat symlink at the old path.

### Manual

```bash
pnpm install && pnpm build && pnpm link --global
```

## Getting started

> **Shortcut:** run `rly welcome` for a 6-step interactive tour that covers everything below plus auto-approve and the dashboards. Full reference in [`docs/getting-started.md`](docs/getting-started.md).

1. **Register a repo.** From inside any repo you want Relay to manage:

   ```bash
   rly up
   ```

   This writes the repo into `~/.relay/workspace-registry.json`.

2. **Set your tokens.** Copy the template and fill it in:

   ```bash
   cp ~/.relay/config.env.template ~/.relay/config.env
   # edit ~/.relay/config.env
   source ~/.relay/config.env
   ```

   `GITHUB_TOKEN` unlocks GitHub issue ingestion and the PR watcher. `LINEAR_API_KEY` unlocks Linear issue ingestion. `HARNESS_LIVE=1` switches from the scripted demo to real Claude/Codex adapters. Add `source ~/.relay/config.env` to your `~/.zshrc` so every shell picks it up.

3. **Sanity check.**

   ```bash
   rly doctor
   ```

   Verifies workspace paths, MCP wiring, and token presence.

4. **Launch a session.**

   ```bash
   rly claude    # or: rly codex
   ```

   These wrap your normal CLI and attach the Relay MCP server.

### End-to-end workflow

Once tokens are set and a session is running, paste a GitHub or Linear issue URL (or a bare Linear key like `ABC-123`) to the agent. Relay:

1. Pulls the issue (title, body, labels, branch hint) via the tracker integration.
2. Classifies it into a complexity tier and generates a plan.
3. Decomposes the plan into parallelizable tickets and executes them.
4. Opens PRs via the SCM integration and tracks them — when `GITHUB_TOKEN` is set the PR watcher polls CI / review state every 30s and posts updates into the ticket's channel. CI failures and change-requested reviews turn into real follow-up tickets via the scheduler.
5. Surfaces live state in the dashboards.

The **TUI** (`rly tui`, built with `--with-tui`) and **GUI** (built with `--with-gui`) are optional dashboards over the same `~/.relay/` data — every operation they show is also available via CLI (`status`, `running`, `board`, `channels`, `decisions`, `list-runs`, …).

## How it works

1. **Classify** — incoming request is triaged into a complexity tier
2. **Plan** — planner agent generates a phased plan
3. **Decompose** — plan splits into parallelizable tickets with dependency DAGs
4. **Approve** — large/architectural requests wait for user approval via MCP
5. **Execute** — ticket scheduler runs independent tickets concurrently (max 3)
6. **Verify** — each ticket gets implement → verify → retry loops with failure classification

### Complexity tiers

| Tier | Behavior |
|------|----------|
| `trivial` | Heuristic match (typo, rename, lint) — skip planning, single ticket |
| `bugfix` | Heuristic match — debug-first flow |
| `feature_small` | LLM classification — lightweight plan, no approval |
| `feature_large` | Full plan, user approval required |
| `architectural` | Design doc phase, then plan, then approval |
| `multi_repo` | Like feature_large + crosslink coordination |

## CLI commands

| Command | Description |
|---------|-------------|
| `rly up` | Register repo in global workspace |
| `rly status` | Workspace paths and recent runs |
| `rly list-runs` | Recent persisted runs |
| `rly list-workspaces` | All registered workspaces |
| `rly claude` | Launch Claude with Relay MCP attached |
| `rly codex` | Launch Codex with Relay MCP attached |
| `rly channels` | List channels |
| `rly channel create <name>` | Create a channel |
| `rly channel <id>` | Show channel details + feed |
| `rly running` | Active tasks across all workspaces |
| `rly board <channelId>` | Task board (tickets by status) |
| `rly decisions <channelId>` | Decision history |
| `rly doctor` | Workspace + MCP diagnostics |
| `rly crosslink status` | Active agent sessions |
| `rly pr-watch <url-or-#>` | Track a PR in the active watcher |
| `rly pr-status` | List PRs currently tracked by the watcher |
| `rly tui` | Launch the ratatui dashboard (auto-builds on first run) |
| `rly gui` | Launch the Tauri desktop app (auto-builds on first run; `--dev` for hot reload) |
| `rly rebuild` | Rebuild the TS dist; `--tui` / `--gui` / `--all` to rebuild more |
| `rly welcome` | 6-step interactive tour of Relay's concepts and commands |

`agent-harness <cmd>` is accepted as a legacy alias for `rly <cmd>` — both binaries are shipped so existing scripts don't break. `rly` reads current TypeScript source by default (via `tsx`), so a rebuild is **not** required after `git pull`. Set `RELAY_USE_DIST=1` for the compiled dist if you want slightly faster startup.

## MCP tools (15)

**Harness (6):** `harness_status`, `harness_list_runs`, `harness_get_run_detail`, `harness_get_artifact`, `harness_approve_plan`, `harness_reject_plan`

**Channels (6):** `channel_create`, `channel_get`, `channel_post`, `channel_record_decision`, `channel_task_board`, `harness_running_tasks`

**Crosslink (3):** `crosslink_discover`, `crosslink_send`, `crosslink_poll`

## Architecture

All data lives at `~/.relay/` (older installs at `~/.agent-harness/` are auto-migrated):

```
~/.relay/
  workspace-registry.json
  workspaces/<repo-hash>/
    artifacts/
      runs-index.json
      <runId>/
        run.json              # full snapshot
        events.jsonl          # incremental event log
        ticket-ledger.json
        classification.json
        approval.json
  channels/<channelId>.json
    feed.jsonl
    decisions/<id>.json
  crosslink/
    sessions/
    mailboxes/
  agent-names.json
```

## Key concepts

- **Channels** — Slack-like spaces where agents collaborate. Messages, decisions, and runs live in channels.
- **Tickets** — parallelizable work units with dependency DAGs, decomposed from plans.
- **Named agents** — display name registry so you can see which agent did what.
- **Decisions** — recorded with rationale and alternatives considered, queryable per channel.
- **Crosslink** — file-based session discovery and messaging between concurrent agent sessions.

## Desktop GUI

A Tauri desktop app under `gui/` mirrors the TUI's channel/board/decisions layout.

Easiest way (from anywhere):

```bash
rly gui             # builds the release bundle on first run, then `open`s the .app
rly gui --dev       # hot-reload Vite + Tauri dev window (keeps terminal attached)
rly gui --rebuild   # force a rebuild even if the bundle already exists
```

Direct `pnpm` scripts (useful when hacking on the GUI from the repo):

```bash
pnpm gui:dev      # launch dev window (Vite + Tauri)
pnpm gui:build    # produce a release .app/.dmg
```

The Rust backend in `gui/src-tauri/` shares `crates/harness-data` with the TUI, so both read the same `~/.relay/` files. Prereqs: `cargo` (rustup) and Xcode command-line tools on macOS.

## Tracker & PR integrations

Relay consumes Composio's [`@aoagents/ao-core`](https://www.npmjs.com/package/@aoagents/ao-core) plugin packages for issue-tracker and SCM integrations. No plugin from their stack runs Relay itself — we import only the leaf adapters.

### Issue-URL ingestion

If the first argument to the classifier is a GitHub or Linear issue URL (or a bare Linear key like `ABC-123`), Relay fetches the full issue (title, body, labels, branch hint) and feeds it into classification. Classifier output carries an optional `suggestedBranch` so downstream ticket creation can match the tracker's native branch name.

Tokens are read from the environment:

- `GITHUB_TOKEN` — GitHub issues + PR watcher
- `LINEAR_API_KEY` (or `COMPOSIO_API_KEY`) — Linear issues

### PR watcher

`src/integrations/pr-poller.ts` polls all tracked PRs via `enrichSessionsPRBatch` (30s by default). State transitions (CI pass→fail, review pending→changes_requested, PR merged/closed) post entries into the ticket's channel. CI failures and change-request reviews turn into real follow-up tickets via the scheduler's dynamic `enqueue` surface.

### AO-compatible notifier

`src/channels/ao-notifier.ts` exports `HarnessChannelNotifier` implementing AO's `Notifier` interface on top of the channel store. If you ever run Composio's `ao` orchestrator, Relay can be plugged in as its notifier without a rewrite.

## Flags

- `HARNESS_LIVE=1` — use real Claude/Codex adapters instead of scripted simulation
- `RELAY_AUTO_APPROVE=1` (or `--auto-approve` / `--yolo` on the CLI) — run fully unattended: Claude launches with `--dangerously-skip-permissions`, Codex with `--full-auto` + workspace-write sandbox + `--ask-for-approval never`, and internal scheduler-dispatched agents inherit. Required for multi-hour runs where you don't want permission prompts. Only use when you trust the tasks you're dispatching.
- `RELAY_USE_DIST=1` — run the pre-built `dist/cli.js` in-process instead of launching TypeScript source via `tsx`. Slightly faster startup (~80 ms), but stale if you haven't run `rly rebuild` since the last source change. Default behavior reads source, so no rebuild is required after `git pull`.
- `--sequential` — use v1 sequential orchestrator instead of v2 ticket-based
- `--no-harness-mcp` — launch Claude/Codex without attaching the Relay MCP server
