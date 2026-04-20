# Getting started with Relay

A 10-minute read. Once you're past Install, run `rly welcome` for the interactive tour — this doc is the reference it points at.

## 1. Install

One command from a fresh clone:

```bash
./install.sh
```

The installer verifies prereqs (`node >=20`, `pnpm`, `git`), builds the TS, links the `rly` and `agent-harness` binaries on your PATH, and scaffolds `~/.relay/config.env.template`. Safe to re-run.

Add `--with-tui` / `--with-gui` to build the Rust dashboards, or `--skip-link` for CI.

If you've previously installed the tool under the old `agent-harness` name, the installer auto-migrates `~/.agent-harness/` → `~/.relay/` and leaves a back-compat symlink.

## 2. Tokens

```bash
cp ~/.relay/config.env.template ~/.relay/config.env
# edit ~/.relay/config.env and set tokens
echo 'source ~/.relay/config.env' >> ~/.zshrc
source ~/.zshrc
```

| Env var | What it unlocks |
|---|---|
| `GITHUB_TOKEN` | GitHub issue ingestion + PR watcher (auto CI/review follow-ups) |
| `LINEAR_API_KEY` | Linear issue ingestion |
| `HARNESS_LIVE=1` | Real Claude/Codex adapters instead of the scripted demo |
| `RELAY_AUTO_APPROVE=1` | Unattended mode — no permission prompts. Required for multi-hour runs |

## 3. Mental model

```
     you type something          tracker URL?
            │                        │
            ▼                        ▼
      ┌─────────────┐         ┌────────────┐
      │ classifier  │ ◄───────┤  resolve   │
      └──────┬──────┘         └────────────┘
             │ complexity tier
             ▼
      ┌─────────────┐
      │  planner    │
      └──────┬──────┘
             │ phased plan
             ▼
      ┌─────────────┐     parallel, max 3 concurrent
      │ decomposer  │ ──► [ticket A] [ticket B] [ticket C]
      └─────────────┘         │         │         │
                              ▼         ▼         ▼
                         implement → verify → retry
                              │
                              ▼
                         PR opens
                              │
                              ▼
                   ┌─────────────────────┐
                   │   PR watcher        │
                   │   (every 30s)       │
                   └──────────┬──────────┘
                              │
         CI fail / changes_requested ──► new follow-up tickets
                              │
                              ▼
                           merged
```

### The five nouns

- **Channel** — a Slack-like space for one piece of work. Carries a feed, ticket ledger, decisions, and linked runs.
- **Session** — your Claude/Codex CLI with the Relay MCP server attached. All agent activity flows through it.
- **Run** — one execution of the classifier → planner → scheduler pipeline. Lives under a channel.
- **Ticket** — a parallelisable work unit produced by the decomposer. Has dependencies, retry budget, verification commands.
- **Decision** — a recorded choice with rationale + alternatives considered. Queryable per channel.

## 4. Your first flow

```bash
cd /path/to/some/repo
rly up                # register the repo
rly doctor            # sanity check
rly claude            # launch a session — paste a request or issue URL
rly board <channelId> # watch tickets move
rly pr-status         # see live PRs as they open
```

Issue URLs (GitHub, Linear, or bare `ABC-123` Linear keys) are auto-resolved — the classifier fetches full title / body / labels / branch hint before planning.

## 5. Dashboards

Three views, all backed by the same `~/.relay/` files.

```bash
rly channels              # CLI list
rly board <channelId>     # CLI kanban
rly tui                   # ratatui terminal dashboard
rly gui                   # Tauri desktop app
```

`rly tui` auto-builds `relay-tui` on first run (~1 min). `rly gui` auto-builds the `.app` bundle on first run (~2–3 min) then `open`s it. `rly gui --dev` launches the Vite hot-reload flow.

## 6. Going unattended

For multi-hour runs where you don't want to click "allow" every few minutes:

```bash
export RELAY_AUTO_APPROVE=1        # or in ~/.relay/config.env
rly claude
```

This passes `--dangerously-skip-permissions` to Claude and `--full-auto` + workspace-write sandbox to Codex. **Only use when you trust the tasks you're dispatching** — there's no per-tool review.

One-off: `rly claude --yolo` or `rly claude --auto-approve`.

## 7. Day-to-day commands

| Command | What it does |
|---|---|
| `rly status` | Workspace paths, recent runs, MCP state |
| `rly running` | Active tasks across every registered workspace |
| `rly channels` | List channels (sorted by most-recent activity) |
| `rly channel <id>` | Show one channel's feed |
| `rly board <id>` | Tickets-by-status kanban |
| `rly decisions <id>` | Recorded decisions with rationale |
| `rly list-runs` | Recent persisted runs across workspaces |
| `rly pr-watch <url>` | Manually track a PR |
| `rly pr-status` | Show tracked PRs with CI / review state |
| `rly crosslink status` | Active cross-session messaging |
| `rly doctor` | Diagnostics |
| `rly rebuild` | Rebuild TS dist / `--tui` / `--gui` / `--all` |
| `rly welcome --reset` | Re-run the interactive tour |

## 8. Advanced

- **Crosslink**: concurrent `rly claude` sessions in different repos can discover and message each other via `crosslink_discover` / `crosslink_send` / `crosslink_poll` / `crosslink_reply`. Useful for multi-repo refactors.
- **Scheduler enqueue**: PR follow-ups (CI fail / changes-requested) become real tickets via the scheduler's dynamic `enqueue` surface, so the loop closes without human intervention.
- **AO-compatible notifier**: `src/channels/ao-notifier.ts` implements Composio's Notifier interface so Relay can be plugged in as an AO notifier if you ever run their stack.
- **MCP tools**: 15 exposed to Claude/Codex. See `rly inspect-mcp` for the live list.

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "GITHUB_TOKEN not set — PR watching disabled" | Expected if you didn't set the token; PRs won't auto-track. |
| Claude keeps prompting for permissions | Set `RELAY_AUTO_APPROVE=1` or pass `--yolo`. |
| `rly` runs stale code after `git pull` | Default behavior reads current source via `tsx`, so this shouldn't happen. If you set `RELAY_USE_DIST=1`, run `rly rebuild`. |
| `rly tui` / `rly gui` fails on first run | Install `cargo` (rustup). The auto-build needs it. |
| TUI shows no channels | Make sure you've registered at least one workspace with `rly up`. |
| GUI shows stale data | `rly gui --rebuild` to refresh the bundle after a code change. |

## 10. Where to go next

- Read `README.md` for the full feature matrix.
- Run `rly inspect-mcp` to see every MCP tool exposed to your agent.
- Run `rly welcome --reset` any time to re-play the interactive tour.
