# Agent Harness

Local-first orchestration for phase-driven coding with Claude and Codex adapters. Classifies requests by complexity, decomposes work into parallelizable tickets, and executes them with verification loops.

## Quickstart

```bash
pnpm install && pnpm build && pnpm link --global

# Register a repo (stores config at ~/.agent-harness/)
cd /path/to/your/repo
agent-harness up

# Use the wrapper around your normal CLI
agent-harness claude
agent-harness codex

# Run the scripted demo
pnpm demo
```

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
| `agent-harness up` | Register repo in global workspace |
| `agent-harness status` | Workspace paths and recent runs |
| `agent-harness list-runs` | Recent persisted runs |
| `agent-harness list-workspaces` | All registered workspaces |
| `agent-harness claude` | Launch Claude with harness MCP attached |
| `agent-harness codex` | Launch Codex with harness MCP attached |
| `agent-harness channels` | List channels |
| `agent-harness channel create <name>` | Create a channel |
| `agent-harness channel <id>` | Show channel details + feed |
| `agent-harness running` | Active tasks across all workspaces |
| `agent-harness board <channelId>` | Task board (tickets by status) |
| `agent-harness decisions <channelId>` | Decision history |
| `agent-harness doctor` | Workspace + MCP diagnostics |
| `agent-harness crosslink status` | Active agent sessions |

## MCP tools (15)

**Harness (6):** `harness_status`, `harness_list_runs`, `harness_get_run_detail`, `harness_get_artifact`, `harness_approve_plan`, `harness_reject_plan`

**Channels (6):** `channel_create`, `channel_get`, `channel_post`, `channel_record_decision`, `channel_task_board`, `harness_running_tasks`

**Crosslink (3):** `crosslink_discover`, `crosslink_send`, `crosslink_poll`

## Architecture

All data lives at `~/.agent-harness/`:

```
~/.agent-harness/
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

```bash
pnpm gui:dev      # launch dev window (Vite + Tauri)
pnpm gui:build    # produce a release .app/.dmg
```

The Rust backend in `gui/src-tauri/` shares `crates/harness-data` with the TUI, so both read the same `~/.agent-harness/` files.

## Tracker & PR integrations

Harness consumes Composio's [`@aoagents/ao-core`](https://www.npmjs.com/package/@aoagents/ao-core) plugin packages for issue-tracker and SCM integrations. No plugin from their stack runs harness itself — we import only the leaf adapters.

### Issue-URL ingestion

If the first argument to the classifier is a GitHub or Linear issue URL (or a bare Linear key like `ABC-123`), the harness fetches the full issue (title, body, labels, branch hint) and feeds it into classification. Classifier output carries an optional `suggestedBranch` so downstream ticket creation can match the tracker's native branch name.

Tokens are read from the environment:

- `GITHUB_TOKEN` — GitHub issues + PR watcher
- `LINEAR_API_KEY` (or `COMPOSIO_API_KEY`) — Linear issues

### PR watcher

`src/integrations/pr-poller.ts` polls all tracked PRs via `enrichSessionsPRBatch` (30s by default). State transitions (CI pass→fail, review pending→changes_requested, PR merged/closed) post `status_update` entries into the ticket's channel. CI failures and change-request reviews emit a `FollowUpRequest` through an injected `FollowUpDispatcher`; wiring that dispatcher into the scheduler so it creates real follow-up tickets is the next piece of work.

### AO-compatible notifier

`src/channels/ao-notifier.ts` exports `HarnessChannelNotifier` implementing AO's `Notifier` interface on top of the channel store. If you ever run Composio's `ao` orchestrator, harness can be plugged in as its notifier without a rewrite.

## Flags

- `HARNESS_LIVE=1` — use real Claude/Codex adapters instead of scripted simulation
- `--sequential` — use v1 sequential orchestrator instead of v2 ticket-based
- `--no-harness-mcp` — launch Claude/Codex without attaching the harness MCP server
