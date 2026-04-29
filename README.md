<p align="center">
  <img src="gui/src-tauri/icons/icon.svg" alt="Relay" width="96" height="96"/>
</p>

<h1 align="center">Relay</h1>

<p align="center">
  <b>Slack for your coding agents.</b><br/>
  Coordinate coding agents across repos — with an audit trail.
</p>

<p align="center">
  Runs inside your existing Claude or Codex CLI via MCP. Local-first, self-hosted, all state in <code>~/.relay/</code> on your machine. No hosted service, no telemetry.
</p>

<p align="center">
  <a href="https://github.com/jcast90/relay/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI" src="https://github.com/jcast90/relay/actions/workflows/ci.yml/badge.svg?branch=main"/></a>
  <a href="https://github.com/jcast90/relay/actions/workflows/release.yml"><img alt="Release" src="https://github.com/jcast90/relay/actions/workflows/release.yml/badge.svg"/></a>
  <a href="https://github.com/jcast90/relay/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/jcast90/relay?include_prereleases&sort=semver&display_name=tag"/></a>
  <a href="https://www.npmjs.com/package/@jcast90/relay"><img alt="npm" src="https://img.shields.io/npm/v/@jcast90/relay?label=npm&color=cb3837"/></a>
</p>

<p align="center">
  <a href="#install"><img alt="install" src="https://img.shields.io/badge/install-one_command-89b4fa?style=flat-square"/></a>
  <a href="#license"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-a6e3a1?style=flat-square"/></a>
  <a href="#dashboards"><img alt="dashboards" src="https://img.shields.io/badge/dashboards-CLI_%2B_TUI_%2B_GUI-cba6f7?style=flat-square"/></a>
</p>

---

> ⚠️ **Beta — pre-v1.** Relay is actively developed and hasn't cut a 1.0 yet. APIs, CLI flags, file layouts under `~/.relay/`, and GUI surfaces can change between releases. Expect bugs. If you hit one, please [open an issue](https://github.com/jcast90/relay/issues/new) with a reproduction — or send a PR. Newcomer-friendly work is tagged [`good first issue`](https://github.com/jcast90/relay/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22); meatier tickets live under [`help wanted`](https://github.com/jcast90/relay/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22). Pick something up and comment "I'll take this."

## What makes Relay different

The agent-harness space is crowded, but most tools solve only **one** of: running agents in parallel, orchestrating a single repo, or wrapping everything in a chat UI. Relay is built for the work that needs all three — with first-class cross-repo coordination on top.

- 🗣 **Agents talk to each other — not just run side-by-side.** Sessions in different repos discover each other through MCP crosslink tools. A live agent in the `backend` repo can ask the live agent in the `web` repo a question instead of grepping its files. Parallel agent runners don't do this; Relay does.
- 📋 **One ticket board spans many repos.** Tickets carry a dependency DAG and `assignedAlias` routing — a feature touching 3 repos is one plan with 3 ticket streams, not 3 uncorrelated sessions. Single-repo orchestrators can't express this.
- 💬 **Every decision is logged with rationale + alternatives.** Like Slack threads, but for architectural choices. Step away for 4 hours, come back to an audit trail — who chose what, why, and what else was considered. Most harnesses don't persist anything beyond the raw transcript.
- 🎛 **Three dashboards, one source of truth — no cloud.** CLI (`rly`), ratatui TUI, and Tauri desktop GUI all read the same `~/.relay/` files. No sync layer, no split brain, no hosted service, no telemetry. Rare in AI tooling, required in regulated environments.
- 🗂 **GitHub Projects v2 integration (v0.2).** Channels project to a GH Projects v2 board automatically — channels become epics, tickets become draft items, with `Type` / `Status` / `Priority` custom fields kept in sync. Relay stays authoritative; drift detected on the GitHub side is logged to the channel feed and overwritten. Paste a Projects item URL into chat and the classifier resolves the project + epic + creates the ticket. See [`docs/trackers.md`](./docs/trackers.md).

## What Relay is

Relay turns a sentence, a GitHub issue URL, or a Linear ticket into a **running plan of AI-coded work**: classify → plan → decompose into a ticket DAG → dispatch to Claude or Codex agents → verify → open PR → track until merged. Every event — tool calls, state changes, decisions — lands in a Slack-style channel feed you can query later.

Suitable for individual developers and teams. CLI: **`rly`**.

## Use cases

Where Relay earns its keep today:

**1. Multi-repo feature rollouts.** You change an API contract in `backend`, the frontend needs the new payload shape, and the client SDK needs a version bump. One channel, three attached repos, dependency DAG ensures the backend ticket completes before the frontend / SDK work starts. Agents crosslink-message each other as shapes stabilize.

**2. Dependency upgrades that ripple.** Bumping a shared library across a dozen service repos. One ticket per repo, agents run in parallel (capped by max-concurrency), status on one board. Agents that hit a migration wall post a decision with alternatives before continuing — so the fifth repo's agent inherits the first repo's answer instead of re-solving it.

**3. Incident response + post-mortems.** Fixes that span services — the `api` hotfix, the `worker` retry change, the `infra` timeout bump. Relay's decision log, with rationale and alternatives per decision, doubles as the post-mortem artifact. Named agents ("Saturn reviewed the migration") give the writeup a coherent narrative instead of `agent-3`.

**4. Long-form refactors.** "Migrate every `axios` call to `fetch` across 40 repos." One autonomous channel, tickets per repo, approval gates at milestones. Run it with `rly run --autonomous <channelId> --budget-tokens 500000 --max-hours 8`, step away, come back to a stack of PRs and a decision log showing what each agent chose.

**5. Overnight autonomous runs.** Queue a backlog Friday evening, run with a budget cap. Monday you have merged PRs plus a decision log showing each architectural choice. Bounded by wall-clock, token budget, and a STOP-file kill switch — not "trust the agent and hope."

## Table of contents

- [Install](#install)
  - [Install prerequisites (platform notes)](#install-prerequisites-platform-notes)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Key concepts](#key-concepts)
- [Dashboards](#dashboards)
- [CLI reference](#cli-reference)
- [MCP tools](#mcp-tools)
- [Integrations](#integrations)
- [Multi-provider](#multi-provider)
- [Unattended mode](#unattended-mode)
- [Storage & execution backends](#storage--execution-backends)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Contributing](#contributing)
- [Known limits](#known-limits)
- [Roadmap](#roadmap)
- [License](#license)

## Install

### Quick start

```bash
npm install -g @jcast90/relay
rly welcome
```

…or without globally installing:

```bash
npx @jcast90/relay welcome
```

The npm package is published under the `@jcast90` scope because both
unscoped `relay` and `rly` were already taken on npm when Relay shipped.
The binary exposed on `$PATH` is still `rly`.

### From source

```bash
git clone https://github.com/jcast90/relay
cd relay
./install.sh
rly welcome
```

Prereq checks (`node >= 20`, `pnpm`, `git`; plus `cargo` if you add `--with-tui` or `--with-gui`; plus Linux Tauri system libs if you add `--with-gui` on Linux), `pnpm install && pnpm build`, links the `rly` binary on your `$PATH`, scaffolds `~/.relay/config.env.template`. Safe to re-run.

- `--with-tui` also builds the Rust dashboard.
- `--with-gui` also builds the Tauri desktop app. On Linux, the preflight will offer to `apt-get install` the required system libraries if they're missing.
- `--skip-link` skips the global link (useful in CI).

### GUI app

Download the `.dmg` (macOS) / `.AppImage` + `.deb` (Linux) / `.msi` (Windows) from the [latest release](https://github.com/jcast90/relay/releases/latest).

> **Note:** pre-release builds are **unsigned**. macOS will show a
> Gatekeeper warning on first open — right-click → _Open_ the first
> time. Windows SmartScreen will ask for a click-through. Code
> signing + notarization is on the [Roadmap](#roadmap).

### Manual

```bash
pnpm install && pnpm build && pnpm link --global
```

### Install prerequisites (platform notes)

**macOS**: Xcode Command Line Tools (`xcode-select --install`). Nothing else required.

**Ubuntu / Debian** (needed for `--with-gui`): install the Tauri system deps first —

```bash
sudo apt-get update
sudo apt-get install -y \
  libglib2.0-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Windows**: no extra system deps for the CLI. The GUI needs [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 11).

### How `rly` finds the source

The launcher (`bin/rly.mjs`) runs the current `src/cli.ts` via `tsx` by default — so a `git pull` reflects immediately, no rebuild required. `RELAY_USE_DIST=1` switches to the pre-built `dist/` for slightly faster startup.

## Quickstart

```bash
rly welcome          # 6-step interactive tour (recommended)
# Or manually:
cd /path/to/your/repo
rly up               # register this repo
rly doctor           # sanity-check tokens + MCP wiring
rly claude           # launch Claude with Relay MCP attached
```

Then paste any of these as your first message:

- A plain sentence — `"Add OAuth2 to /api/users"`
- A GitHub issue URL — `https://github.com/owner/repo/issues/42`
- A Linear URL or key — `linear.app/acme/issue/ABC-123` or just `ABC-123`

Relay's classifier picks it up, plans the work, and either executes or asks for approval depending on complexity.

## How it works

```
   your request                        tracker URL detected?
        │                                      │
        ▼                                      ▼
  ┌───────────┐    GitHub / Linear    ┌─────────────────┐
  │classifier │ ◄───────────────────► │  resolve issue  │
  └─────┬─────┘                       └─────────────────┘
        │ complexity tier
        ▼
  ┌───────────┐
  │  planner  │ ──► design doc (if architectural)
  └─────┬─────┘
        │ phased plan
        ▼
  ┌────────────┐
  │ decomposer │ ──► tickets with dependency DAG
  └─────┬──────┘
        │
        ▼
  ┌────────────────┐     parallel, max-concurrency capped
  │   scheduler    │ ──► [T-1] [T-2] [T-3]
  └────────────────┘         │     │     │
                             ▼     ▼     ▼
                        implement → verify → retry
                             │
                             ▼
                         PR opens
                             │
                   ┌─────────┴─────────┐
                   │    PR watcher     │   GITHUB_TOKEN required
                   │    every 30 s     │
                   └─────────┬─────────┘
                             │
    CI fail / changes_requested ──► follow-up tickets
                             │
                             ▼
                          merged
```

### Complexity tiers

| Tier            | Behavior                                                            |
| --------------- | ------------------------------------------------------------------- |
| `trivial`       | Heuristic match (typo, rename, lint) — single ticket, skip planning |
| `bugfix`        | Heuristic match — debug-first flow                                  |
| `feature_small` | LLM classification — lightweight plan, no approval                  |
| `feature_large` | Full plan + **user approval required** via MCP                      |
| `architectural` | Design-doc phase → plan → approval                                  |
| `multi_repo`    | Like `feature_large` + crosslink coordination across repos          |

## Key concepts

### Channels

Slack-style workspaces for one piece of work. Each channel carries:

- **feed** — messages, tool calls, PR state transitions
- **tickets** — unified ticket board (`tickets.json`) shared by chat and the orchestrator
- **runs** — linked orchestrator runs with full event history
- **decisions** — recorded choices with `title / description / rationale / alternatives / linkedArtifacts`, queryable per channel
- **sessions** — persisted chat transcripts (`sessions/<id>.jsonl`)

Channels sort by most-recent activity in the sidebar — the one you're working in stays at the top.

### Primary + associated repos

A channel can attach multiple repos. Exactly **one is primary** — that's where the GUI's main chat agent works and where its `cwd` defaults. Every other attached repo is **associated** — visible to the primary as `alias + path + AGENTS.md summary` (first ~40 lines), not full context.

**Cross-repo work happens through the primary's tools, not by reading:**

- **Quick question** → `crosslink_send` to another repo's live agent
- **Long task** → write a ticket with `assignedAlias: "<repo-alias>"`; the associated agent polls `tickets.json` and picks it up
- Primary is explicitly told **not** to grep or edit associated repo files directly

### Crosslink

Live agents in different repos (each a `rly claude` session) discover each other via heartbeat files in `~/.relay/crosslink/sessions/` and exchange messages. MCP tools: `crosslink_discover` / `crosslink_send` / `crosslink_poll`.

### Spawning associated agents

Opt-in per associated repo at channel creation, or on demand when the primary hits a `no_session` error. The GUI opens a terminal tab running `rly claude` in the repo. Per platform: macOS uses Terminal.app via `osascript` (window/tab ids tracked for targeted close); Linux probes `$TERMINAL` then a chain (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`, `alacritty`, `kitty`, `wezterm`); Windows prefers `wt.exe`, falls back to `powershell.exe` / `cmd.exe`. Tracked per channel in `spawns.json`; kill from the GUI closes the tab on macOS and SIGTERMs (or `taskkill /T /F`) the crosslink session on Linux/Windows. Self-heals against dead crosslink heartbeats.

If no supported terminal is detected, spawn surfaces an error **and** posts a system entry to the channel feed — run `rly claude` in the repo manually and crosslink will pick it up.

### Tickets

Parallelisable work units with:

- dependency DAG (`dependsOn`)
- retry budget (`maxAgentAttempts`, `maxTestFixLoops`)
- specialty tag (`general | ui | business_logic | api_crud | devops | testing`)
- optional `assignedAlias` for routing to a specific associated-repo agent
- verification commands (run against an allowlist, never shelled blindly)

Statuses: `pending | blocked | ready | executing | verifying | retry | completed | failed`.

### Decisions

First-class records with rationale + alternatives, written to `channels/<id>/decisions/<id>.json`. Each write is atomic (temp-rename) — readers (TUI, GUI, other CLI invocations) see a consistent file or the previous version, never a torn one.

### Named agents

Every agent has a display name (`src/domain/agent-names.ts`), so channel feeds show "Saturn reviewed the migration", not "agent-3".

## Dashboards

All three read the same `~/.relay/` files — no synchronization, no split brain.

### CLI

```bash
rly channels                    # list channels (sorted by latest activity)
rly channel <id>                # show channel details + feed
rly board <channelId>           # kanban view of the ticket board
rly decisions <channelId>       # decision history with rationale
rly running                     # active tasks across every workspace
rly status                      # workspace paths + recent runs
rly list-runs [--workspace <id>]
rly doctor                      # diagnostics
```

During `HARNESS_LIVE=1 rly run` with the Claude provider, tool-use events stream inline on stderr — each tool call appears as `⚙ [HH:MM:SS] [agent] Reading foo.ts`. Pass `--quiet` (or set `RELAY_QUIET=1`) to silence the feed without affecting stdout.

### TUI (ratatui)

```bash
rly tui                         # auto-builds on first run (~1 min)
```

Vertical channel sidebar · feed · task board · decisions · agents. Keyboard-driven, fast. While a Claude session is streaming, the chat pane shows a live tool-use stack (newest tool call, recent history, and a `last update …` timestamp) — matching the GUI's activity card.

### GUI (Tauri desktop app)

```bash
rly gui                         # auto-builds the .app on first run (~2–3 min), then opens it
rly gui --dev                   # hot-reload Vite + Tauri window
rly gui --rebuild               # force rebuild
```

Catppuccin Mocha theme. Three tabs per channel:

- **Chat** — live streaming with thinking previews + tool-call rail + pulsing accent indicator
- **Board** — kanban with empty columns hidden, per-column scroll, click-any-ticket detail modal with dependency tree
- **Decisions** — chronological decision list with rationale

Right pane shows repo assignments (with `PRIMARY` badge), pinned refs, and — when present — a **Spawned agents** section with kill buttons.

## CLI reference

| Command                                                                                                                             | What it does                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rly welcome`                                                                                                                       | 6-step interactive tour (pass `--reset` to replay)                                                                                                               |
| `rly up`                                                                                                                            | Register the current repo in the global workspace                                                                                                                |
| `rly status`                                                                                                                        | Workspace paths + recent runs                                                                                                                                    |
| `rly list-runs`                                                                                                                     | Recent persisted runs across workspaces                                                                                                                          |
| `rly list-workspaces`                                                                                                               | All registered workspaces                                                                                                                                        |
| `rly claude`                                                                                                                        | Launch Claude with Relay MCP attached                                                                                                                            |
| `rly codex`                                                                                                                         | Launch Codex with Relay MCP attached                                                                                                                             |
| `rly channels`                                                                                                                      | List channels (most-recently-active first)                                                                                                                       |
| `rly channel create <name> [--repos alias:wsId:path,...] [--primary <alias>]`                                                       | Create a channel                                                                                                                                                 |
| `rly channel update <id> [--repos ...] [--primary <alias>]`                                                                         | Update repos / primary                                                                                                                                           |
| `rly channel archive <id>`                                                                                                          | Archive a channel                                                                                                                                                |
| `rly channel unarchive <id>`                                                                                                        | Restore an archived channel                                                                                                                                      |
| `rly channel <id>`                                                                                                                  | Show channel details + recent feed                                                                                                                               |
| `rly channel feed <id> [--limit N]`                                                                                                 | Raw feed entries                                                                                                                                                 |
| `rly channel post <id> <content> [--from <name>] [--type <type>]`                                                                   | Post to the feed                                                                                                                                                 |
| `rly channel link-linear <id> <linearProjectId>`                                                                                    | Bind a Linear project to the channel + do a first read-only mirror of its issues onto the ticket board (requires `LINEAR_API_KEY`)                               |
| `rly channel linear-sync <id>`                                                                                                      | Re-run the Linear → channel-board mirror for a channel already linked                                                                                            |
| `rly running`                                                                                                                       | Active tasks across every workspace                                                                                                                              |
| `rly board <channelId>`                                                                                                             | Kanban view of the ticket board                                                                                                                                  |
| `rly decisions <channelId>`                                                                                                         | Decision history                                                                                                                                                 |
| `rly pr-watch <url-or-#> [--branch <b>] [--ticket <id>] [--channel <id>]`                                                           | Manually track a PR                                                                                                                                              |
| `rly pr-status [--channel <id>] [--json]`                                                                                           | List tracked PRs with CI + review state (reads the on-disk mirror when no orchestrator is running)                                                               |
| `rly approve <runId>`                                                                                                               | Approve a pending plan (same code path as `harness_approve_plan` MCP tool)                                                                                       |
| `rly reject <runId> [--feedback "…"]`                                                                                               | Reject a pending plan                                                                                                                                            |
| `rly pending-plans [--json]`                                                                                                        | List runs awaiting plan-approval decisions                                                                                                                       |
| `rly run --autonomous <channelId> --budget-tokens <N> [--max-hours N] [--trust supervised\|god] [--allow-repo <alias>]... [--json]` | Start an autonomous session against a channel's ticket board. Records a tagged decision entry; driver (AL-4) executes until budget / wall-clock / queue exhausts |
| `rly chat rewind --channel <id> --session <id> [--to <iso> \| --interactive]`                                                       | Roll repos + session transcript back to a rewindable user turn                                                                                                   |
| `rly crosslink status`                                                                                                              | Active cross-session chatter                                                                                                                                     |
| `rly tui`                                                                                                                           | Terminal dashboard (auto-builds on first run)                                                                                                                    |
| `rly gui [--dev] [--rebuild]`                                                                                                       | Desktop dashboard                                                                                                                                                |
| `rly rebuild [--all] [--dist] [--tui] [--gui] [--skip-install]`                                                                     | Rebuild artifacts (runs `pnpm install` first unless skipped)                                                                                                     |
| `rly doctor`                                                                                                                        | Diagnostics: paths, MCP wiring, token presence                                                                                                                   |
| `rly session <create\|list\|get\|delete\|...>`                                                                                      | Session-transcript management                                                                                                                                    |
| `rly chat <system-prompt\|resolve-refs\|mcp-config>`                                                                                | Chat plumbing used by the TUI/GUI                                                                                                                                |
| `rly config <add-project-dir\|remove-project-dir>`                                                                                  | Global config                                                                                                                                                    |
| `rly mcp-server --workspace <path>`                                                                                                 | Run the MCP server (invoked by Claude/Codex automatically)                                                                                                       |
| `rly inspect-mcp`                                                                                                                   | Show the live MCP tool catalogue                                                                                                                                 |

### Two-axis routing on the project board

The autonomous-loop tickets are mirrored to the public [Relay project board](https://github.com/users/jcast90/projects/3), which carries the `(role, repo)` routing model the loop uses to dispatch work. Each issue has a `Status`, `Effort`, `Target Repo`, `Admin`, and `Depends on` field — `Target Repo` is the repo alias the work lands in and `Admin` names the `repo-admin-<alias>` that owns the ticket. Pick up work by filtering `Status: Todo` and making sure `Depends on` is empty or has all dependencies closed. Issues carrying the `relay-seeded` label were generated by Relay's seeder; others are human-authored. The board is resynced idempotently by `scripts/push-tickets-to-github.ts` — re-running it updates field values in place rather than creating duplicates.

## MCP tools

Exposed to Claude and Codex via the Relay MCP server:

**Harness (9)**: `harness_status`, `harness_list_runs`, `harness_get_run_detail`, `harness_get_artifact`, `harness_approve_plan`, `harness_reject_plan`, `harness_dispatch`, `project_create`, `pr_review_start`

**Channels (6)**: `channel_create`, `channel_get`, `channel_post`, `channel_record_decision`, `channel_task_board`, `harness_running_tasks`

**Crosslink (3)**: `crosslink_discover`, `crosslink_send`, `crosslink_poll`

Run `rly inspect-mcp` for the authoritative live list.

## Integrations

### Issue trackers (tracker-github, tracker-linear)

Built on Composio's [`@aoagents/ao-core`](https://www.npmjs.com/package/@aoagents/ao-core) leaf plugins. Paste a GitHub or Linear URL (or a bare Linear key like `ABC-123`) as your first message — the classifier fetches the full issue (title / body / labels / branch hint) before planning. The classifier output carries an optional `suggestedBranch` so generated PRs match the tracker's native branch name.

Tokens:

- `GITHUB_TOKEN` — GitHub issues + PR watcher + GitHub Projects v2 sync (needs `project` scope; `read:org` for org-owned projects)
- `LINEAR_API_KEY` (or `COMPOSIO_API_KEY`) — Linear issues

### GitHub Projects v2 (v0.2, new)

Relay channels project onto a GH Projects v2 board: channel → epic draft item, ticket → child draft item, with `Type` / `Status` / `Priority` custom fields kept in sync by a one-way Relay-authoritative sync worker. URL-paste a Projects v2 item into chat and the classifier resolves the project + epic + creates the ticket. Reuses `GITHUB_TOKEN`. Full reference: [`docs/trackers.md`](./docs/trackers.md).

### PR watcher (scm-github)

With `GITHUB_TOKEN` set, any orchestrator run starts a background poller that uses AO's `enrichSessionsPRBatch` every 30 s. State transitions — `ci: passing → failing`, `review: pending → changes_requested`, `prState: merged` — post `status_update` entries into the ticket's channel. CI failures and change-request reviews **turn into real follow-up tickets** via the scheduler's dynamic `enqueue` — no manual retriage.

`rly pr-watch <url>` manually tracks a PR outside the auto-detect loop. `rly pr-status` shows everything tracked.

### AO notifier compatibility

`src/channels/ao-notifier.ts` exports `HarnessChannelNotifier implements Notifier` — so you can drop Relay in as a notifier plugin for Composio's `ao` orchestrator without a rewrite.

## Multi-provider

Relay's two CLI adapters (`claude`, `codex`) accept any endpoint that speaks their wire protocol, so **any provider exposing an OpenAI-compatible or Anthropic-compatible HTTP API works today with zero code changes** — just set the adapter's base-URL + key env vars. Known-good targets: MiniMax, OpenRouter, DeepSeek, Groq, Together, LiteLLM, vLLM.

```bash
# Route Codex through MiniMax.
export HARNESS_PROVIDER=codex
export OPENAI_BASE_URL=https://api.minimax.io/v1
export OPENAI_API_KEY=$MINIMAX_API_KEY
export HARNESS_AGENT_ATLAS_MODEL=MiniMax-M2
rly run "Add a health endpoint"
```

For smoke-testing + per-agent overrides + named profiles, see [`docs/providers.md`](./docs/providers.md).

```bash
rly providers profiles list              # named profiles
rly providers profiles add <id> ...      # save a profile for reuse
rly providers default <id|clear>         # pick a default profile
rly channel set-provider <ch> <pid>      # pin a channel to a profile
```

Profiles never store secrets — they reference env-var names (e.g. `apiKeyEnvRef: "MINIMAX_API_KEY"`), and `rly providers profiles add` rejects any `--env KEY=VAL` whose value looks like a raw key. The GUI has a Provider dropdown per channel (Settings drawer → About tab) and a Providers tab in the global Settings page for full CRUD.

**Not yet shipped:** native adapters for coding CLIs that aren't Claude- or Codex-compatible (Cursor, Gemini, Aider). See the Roadmap for status.

## Unattended mode

For multi-hour runs where you don't want to click "allow" on every tool call:

```bash
export RELAY_AUTO_APPROVE=1     # in ~/.relay/config.env or your shell
rly claude
```

Under the hood:

- Claude launches with `--dangerously-skip-permissions`
- Codex launches with `--sandbox workspace-write` + `--ask-for-approval never`
- Internal scheduler-dispatched agents inherit via `RELAY_AUTO_APPROVE` propagated in the child env

One-off: `rly claude --yolo` or `rly claude --auto-approve`.

**Use this only when you trust the tasks you're dispatching.** No per-tool review means `rm -rf`, `git push --force`, and unlinked network calls all go through without asking.

## Storage & execution backends

### Storage

Relay stores everything in `~/.relay/` as JSON/JSONL files (atomic writes via tmp+rename). One backend, no DB required. All state — runs, tickets, decisions, crosslink messages, agent-names, workspace registry, session transcripts — goes through a single `HarnessStore` interface (`src/storage/store.ts`) so a future backend can slot in without rewriting handlers.

File backend is all that ships today. A Postgres backend (`src/storage/postgres-store.ts`) is **stubbed in-tree** for future multi-agent coordination — `LISTEN/NOTIFY` decision broadcasts and row-locked writes — but **not wired yet**; `HARNESS_STORE=postgres` currently warns and falls back to the file backend. See the [Roadmap](#roadmap).

### Executor

Verification commands run through an `Executor` abstraction (`src/execution/executor.ts`). Today the only shipping impl is **LocalChildProcessExecutor** — spawns locally. A pod-based executor was prototyped but has been removed until it's wired end-to-end; see the OSS-08 PR for context.

## Configuration

### Environment flags

| Var / flag                                                   | Effect                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `HARNESS_LIVE=1`                                             | Use real Claude/Codex adapters instead of the scripted demo                                                        |
| `RELAY_AUTO_APPROVE=1` / `--auto-approve` / `--yolo`         | Unattended mode — no permission prompts. Required for multi-hour runs                                              |
| `RELAY_USE_DIST=1`                                           | Run pre-built `dist/cli.js` instead of live source via `tsx`. Marginally faster startup; stale until `rly rebuild` |
| `GITHUB_TOKEN`                                               | GitHub issues + PR watcher                                                                                         |
| `LINEAR_API_KEY` (or `COMPOSIO_API_KEY`)                     | Linear issues                                                                                                      |
| `CLAUDE_BIN`                                                 | Override the `claude` binary path (default: `claude` on `$PATH`)                                                   |
| `RELAY_QUIET=1` / `HARNESS_QUIET=1` / `--quiet` / `--silent` | Suppress inline tool-use activity during `rly run` (both env vars honored)                                         |
| `--sequential`                                               | Use the v1 sequential orchestrator instead of v2 ticket-based                                                      |
| `--no-harness-mcp`                                           | Launch Claude/Codex without attaching the Relay MCP server                                                         |

### File layout

```
~/.relay/
  config.json                 # global config (project dirs, etc.)
                              #   `tracker` config block — see docs/trackers.md
  config.env.template         # copy to config.env and fill in
  workspace-registry.json     # all registered repos
  workspaces/<hash>/
    artifacts/
      runs-index.json
      <runId>/
        run.json              # full snapshot
        events.jsonl          # incremental event log
        ticket-ledger.json
        classification.json
        approval.json
  channels/<channelId>/
    channel.json              # name, members, repoAssignments, primaryWorkspaceId
                              #   .trackerLinks.githubProjects → projectId, epicItemId, epicDraftIssueId
                              #   (populated when the channel is provisioned against GH Projects v2)
    feed.jsonl                # append-only feed
    tickets.json              # unified ticket board (each ticket may carry .externalIds)
    runs.json                 # linked orchestrator runs
    tracked-prs.json          # PR-watcher mirror (read by TUI/GUI pr-status surfaces)
    decisions/<id>.json       # one file per decision (atomic writes)
    sessions/<sessionId>.jsonl
    spawns.json               # spawned-agent tracking (GUI, all platforms)
  crosslink/
    sessions/<sessionId>.json # live session heartbeats
    mailboxes/<sessionId>/    # pending crosslink messages
    hooks/                    # generated shell hooks for Claude/Codex
  agent-names.json            # display-name registry
```

## Architecture

```
src/
  cli.ts                      # entry point (bin/rly.mjs → tsx → here)
  index.ts                    # CLI dispatch (welcome, claude, codex, board, ...)
  cli/                        # CLI subcommands + launchers (tui, gui, rebuild, welcome)
  orchestrator/               # classifier, planner, decomposer, scheduler, approval
  agents/                     # Claude/Codex CLI adapters, registry, invocation
  channels/                   # ChannelStore, feed, decisions, ao-notifier
  integrations/               # AO plugins — tracker, scm, pr-poller, env-mutex
  execution/                  # executor abstraction, verification-runner
  storage/                    # HarnessStore interface + file / postgres backends
  domain/                     # shared types + zod schemas
  mcp/                        # MCP server + tool definitions
  crosslink/                  # session discovery, messaging, hook generation
  simulation/                 # scripted invoker for the scripted demo mode
  tui/                        # small TS shim that launches the ratatui binary

tui/                          # ratatui dashboard (Rust)
gui/                          # Tauri desktop app — React + Vite frontend, Rust backend
crates/harness-data/          # shared Rust crate consumed by tui + gui (reads ~/.relay/)

docs/getting-started.md       # canonical reference guide
bin/rly.mjs                   # CLI launcher (tsx by default, dist with RELAY_USE_DIST=1)
install.sh                    # one-command installer
```

- `docs/` — human-facing deeper walkthroughs (getting started, storage injection).
- `agent_docs/` — agent-targeted reference (architecture, data model, testing) for coding agents working in the repo.

## Development

```bash
pnpm install
pnpm test                     # 380+ vitest cases
pnpm typecheck                # tsc --noEmit
pnpm build                    # tsc → dist/
pnpm demo                     # scripted simulation, no real API calls
cd gui && pnpm build          # Vite bundle
cargo check --workspace       # all three Rust crates
```

Per-area quick loops:

| What                             | Loop                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| Edit TS source, see CLI change   | Just save — `rly` reads `src/` live via `tsx` (no rebuild) |
| Edit Rust TUI                    | `rly rebuild --tui`                                        |
| Edit Tauri GUI                   | `rly gui --dev` (hot reload)                               |
| After `git pull` pulled new deps | `rly rebuild` (runs `pnpm install` first)                  |

### Testing conventions

- **Vitest** for TS. Tests live in `test/` mirroring `src/`. Live-network tests sit in `describe.skip` blocks.
- **Cargo** for Rust. `cargo test --workspace` covers the TUI / GUI / shared crate.

### Scripted vs. live mode

`HARNESS_LIVE=1` switches from the scripted `ScriptedInvoker` to real Claude/Codex spawns. Leave it off while developing orchestrator logic — the scripted mode is fast and deterministic.

## Contributing

Relay is pre-v1 and issues/PRs are genuinely welcome — including from folks who've never contributed before. If you hit a bug, file it with a reproduction. If you want to help:

- **First-time contributors** → [`good first issue`](https://github.com/jcast90/relay/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22) — small, scoped, concrete. Comment "I'll take this" before you start so two people don't collide.
- **Repeat contributors** → [`help wanted`](https://github.com/jcast90/relay/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22) — bigger efforts like distribution channels, cross-platform CI, and cost guardrails.
- **For larger changes**, open an issue first so we can align on shape before you burn time.

See [`AGENTS.md`](./AGENTS.md) for the coding-agent conventions.

- Keep PR scope tight — prefer multiple small PRs over one big one.
- Run `pnpm test && pnpm typecheck && pnpm build` before pushing.
- Tests for new behavior. No snapshot tests for orchestrator output — assert on shape.
- Formatting: two-space indent, double quotes, semicolons, trailing commas where idiomatic. Run your editor's formatter on touched files.

A **`CLAUDE.md`** at the repo root (when present) tells any Claude agent working in this codebase — including `rly claude` itself — what conventions to follow.

## Known limits

- **Spawn is cross-platform but lightly tested off macOS.** macOS is daily-driven; Linux and Windows branches are compile-checked and unit-tested but real-device integration testing is still the gate before tagging a release.
- **Cost guardrails not yet implemented.** Token usage isn't tracked or capped. Use `RELAY_AUTO_APPROVE=1` with care.

## Roadmap

Honest snapshot — most of these haven't started. Order is rough priority, not commitment.

- **Postgres backend for multi-agent coordination** _(exploratory, stubbed)_ — the file backend serializes writes per-host via tmp+rename atomics. A Postgres-backed `HarnessStore` would let multiple agents (same box or different) share state through `LISTEN/NOTIFY` cross-agent decision broadcasts and row-locked decision writes. Postgres here runs locally (`brew install postgresql && createdb relay`) or remote — this isn't a cloud-only feature. Source stub lives at `src/storage/postgres-store.ts`; not wired into the factory and the integration tests are skipped.
- **Pod executor (Kubernetes)** _(exploratory)_ — verification runs off the dev box in per-ticket pods. Prototype was removed in OSS-08 until it's wired end-to-end again.
- **S3 artifacts** _(exploratory)_ — moving ticket evidence off the local filesystem so it survives pod/host churn. Pairs with the pod executor.
- **Distribution: Homebrew tap + winget manifest** _(planned)_ — for one-line `brew install rly` / `winget install rly` on top of the existing `npm install -g @jcast90/relay` path.
- **Code signing + notarization** _(planned)_ — macOS `.dmg` (Developer ID + `notarytool`) and Windows `.msi` (Authenticode) so downloads don't need right-click-open / SmartScreen bypass. Requires paid certificates and a secret-management pass in the release workflow.
- **Cost guardrails** _(in design)_ — token usage tracking per run, per ticket, per channel, with a soft cap that pauses scheduling when hit. Prerequisite to making `RELAY_AUTO_APPROVE=1` safer for multi-hour runs.
- **Integration test coverage off macOS** _(in progress)_ — Linux and Windows spawn paths are compile-checked but only smoke-tested; promoting them to the fast CI tier is the gate to tagging cross-platform releases.

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgements

- [Composio](https://github.com/ComposioHQ/agent-orchestrator) for `@aoagents/ao-core` and the tracker / SCM plugin surface.
- [Catppuccin Mocha](https://github.com/catppuccin/catppuccin) palette.
- [Tauri](https://tauri.app/), [Ratatui](https://ratatui.rs/), [vitest](https://vitest.dev/), [tsx](https://tsx.is/) — the foundations everything rests on.
