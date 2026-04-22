# Getting started with Relay

The deeper walkthrough. Start here once the README has sold you on the idea and you want to build the mental model.

If you haven't installed yet: `./install.sh` from the repo root, then `cp ~/.relay/config.env.template ~/.relay/config.env` and fill in `GITHUB_TOKEN`, `LINEAR_API_KEY`, `HARNESS_LIVE=1`. The README covers the details.

## From zero to first merged PR

Ten concrete steps. Assumes `GITHUB_TOKEN`, `HARNESS_LIVE=1`, and `RELAY_AUTO_APPROVE=1` are all set.

1. **`cd /path/to/your/repo && rly up`** — registers the repo in `~/.relay/workspace-registry.json`. Expect: `registered workspace <hash> → <path>`.
2. **`rly doctor`** — checks tokens, MCP wiring, binary paths. Expect a grid of green check marks. A red line here means stop and fix before step 3.
3. **`rly claude`** — launches Claude with the Relay MCP server attached. Expect: Claude's banner, then the MCP toolbar showing 17 tools (8 harness / 6 channel / 3 crosslink — run `rly inspect-mcp` for the live source of truth).
4. **Paste a GitHub issue URL** as your first message — e.g. `https://github.com/your-org/your-repo/issues/42`. Expect: the classifier prints `resolved: <title>`, `tier: feature_small`, `suggestedBranch: feat/42-…`.
5. **Planner runs** — you see a phased plan in the feed (`phase 1: scaffold`, `phase 2: wire`, `phase 3: tests`). No approval prompt on `feature_small`; `feature_large`/`architectural` would pause here.
6. **Decomposer emits tickets** — watch the feed print `T-1 … T-4 ready`. Tickets with no `dependsOn` go `ready` immediately; others stay `blocked`.
7. **In a second terminal: `rly board <channelId>`** — live kanban. Tickets move `ready → executing → verifying → completed` as scheduler-dispatched agents pick them up (max 3 concurrent).
8. **First PR opens** — the feed prints `PR #123 opened https://github.com/…`. The PR watcher auto-registers it and begins polling every 30 s.
9. **`rly pr-status`** — shows every tracked PR with live CI + review state. Wait for `ci: passing / review: approved`. If CI fails, the watcher files a follow-up ticket automatically; no manual retriage.
10. **PR merges** — the feed prints `PR #123 merged`. The channel's ticket board shows all tickets `completed`. You never touched the keyboard after step 4.

If you're not on `RELAY_AUTO_APPROVE=1`, steps 3–10 pause for per-tool permission prompts.

## The five nouns

- **Channel** — a Slack-like space for one piece of work. Carries a feed, ticket ledger, decisions, and linked runs.
- **Session** — your Claude/Codex CLI with the Relay MCP server attached. All agent activity flows through it.
- **Run** — one execution of the classifier → planner → scheduler pipeline. Lives under a channel.
- **Ticket** — a parallelisable work unit produced by the decomposer. Has dependencies, retry budget, verification commands.
- **Decision** — a recorded choice with rationale + alternatives considered. Queryable per channel.

## A worked example

Paste this into a fresh `rly claude` session:

```
https://github.com/acme/api/issues/42
```

where issue #42 says _"Rate-limit `/api/search` to 60 req/min per API key, return 429 with `Retry-After` header."_

What happens, in order:

1. **Classifier** hits GitHub, pulls title + body + labels (`enhancement`, `api`, `backend`). Emits `tier: feature_small`, `suggestedBranch: feat/42-rate-limit-search`.
2. **Planner** writes a 3-phase plan: _(1) add middleware + token-bucket store, (2) wire into `/api/search` route, (3) tests + error-shape_. Feed entry `plan_created`.
3. **Decomposer** fans out: `T-1 add rate-limit middleware (general)`, `T-2 wire into /api/search (api_crud, depends on T-1)`, `T-3 integration test for 429 + Retry-After (testing, depends on T-2)`, `T-4 update OpenAPI spec (general, depends on T-2)`. Ticket board is live in `rly board <channelId>`.
4. **Scheduler** starts T-1 (the only `ready` ticket). T-2/T-3/T-4 sit `blocked`. As T-1 completes and verifies, T-2 unblocks, then T-3 + T-4 run in parallel. Max-concurrency defaults to 3 — you can watch the `executing` column fill up.
5. **Each ticket** spawns its own Claude subprocess with a scoped prompt, runs verification commands (test / lint / typecheck) through the `Executor` abstraction, retries up to `maxTestFixLoops` on failure.
6. **PR opens** on branch `feat/42-rate-limit-search`. Feed prints the URL. PR watcher auto-registers.
7. **`rly pr-status`** shows `ci: pending → passing`, `review: pending`. If a reviewer asks for changes, `review: changes_requested` triggers a new follow-up ticket and the loop closes itself.
8. **Merge** — feed prints `PR #123 merged`. Channel stays around as a record of the whole thing; `rly decisions <channelId>` shows every choice with rationale.

## Second channel: cross-repo delegation

The interesting case. You have a monorepo front + back-end, or two separate repos:

```bash
rly channel create "auth-v2" \
  --repos "api:<ws-id>:/path/to/api,web:<ws-id>:/path/to/web" \
  --primary api
```

- `api` is **primary** — the main chat agent runs there; its `cwd` defaults to the API repo.
- `web` is **associated** — visible to the primary as `alias + path + AGENTS.md summary` (first ~40 lines), not full context.

The primary is told **not** to grep or edit `web/` directly. Instead:

- **Quick question** → `crosslink_send` to the live `web` agent ("does `/auth/login` still return a JWT?")
- **Long task** → file a ticket with `assignedAlias: "web"`. The `web` agent polls `tickets.json` and picks it up.

If no `web` agent is live, the primary sees `no_session` and can spawn one from the GUI. Relay opens a terminal tab in the `web` repo running `rly claude`, tracked in `spawns.json`: macOS uses Terminal.app via `osascript` (window/tab ids tracked for targeted close); Linux probes `$TERMINAL` then a chain (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`, `alacritty`, `kitty`, `wezterm`); Windows prefers `wt.exe`, falls back to `powershell.exe` / `cmd.exe`. Kill closes the tab on macOS and SIGTERMs the crosslink session on Linux/Windows. If no supported terminal is found, spawn surfaces an error and posts a channel-feed entry telling you to `rly claude` in the repo manually.

## Mental model (reference)

For when you want to see the pipeline at a glance:

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

## `~/.relay/` file layout

All three dashboards (CLI / TUI / GUI) read the same files. No synchronisation layer — the filesystem _is_ the state.

```
~/.relay/
  config.json                 # global config (project dirs, etc.)
  config.env                  # tokens + flags (source from your shell rc)
  workspace-registry.json     # all registered repos
  workspaces/<hash>/
    artifacts/runs-index.json
    artifacts/<runId>/run.json, events.jsonl, ticket-ledger.json, classification.json, approval.json
  channels/<channelId>/
    channel.json              # name, members, repoAssignments, primaryWorkspaceId
    feed.jsonl                # append-only feed
    tickets.json              # unified ticket board
    runs.json                 # linked orchestrator runs
    decisions/<id>.json       # one file per decision (atomic temp-rename)
    sessions/<sessionId>.jsonl
    spawns.json               # spawned-agent tracking (GUI, all platforms)
  crosslink/
    sessions/<sessionId>.json # live session heartbeats
    mailboxes/<sessionId>/    # pending crosslink messages
    hooks/                    # generated shell hooks for Claude/Codex
  agent-names.json            # display-name registry
```

Today the file backend is the only one that ships. A Postgres backend is stubbed in source (`src/storage/postgres-store.ts`) for future multi-agent coordination but isn't wired yet — see the [Roadmap](../README.md#roadmap).

## Troubleshooting

| Symptom                                                  | Likely cause / fix                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN not set — PR watching disabled`            | Expected if you didn't set the token; PRs won't auto-track. Also posted once per channel to the feed (visible in TUI/GUI) so you see it even if you closed the terminal.                                                                                                          |
| Classifier can't resolve a Linear key like `ABC-123`     | `LINEAR_API_KEY` (or `COMPOSIO_API_KEY`) not set, or the key doesn't match any issue visible to your token.                                                                                                                                                                       |
| Claude keeps prompting for permissions                   | Set `RELAY_AUTO_APPROVE=1` or pass `--yolo` / `--auto-approve`.                                                                                                                                                                                                                   |
| Tickets stuck in `blocked` forever                       | Check `dependsOn` chain — a failed upstream ticket blocks everything downstream. `rly board <id>` shows the edges.                                                                                                                                                                |
| Ticket retries exhausted (`failed`)                      | Verification commands kept failing past `maxTestFixLoops`. Feed shows the last verification output; fix manually, mark the ticket `completed`, and the scheduler unblocks downstream.                                                                                             |
| `Verification override` in feed                          | The agent proposed commands that weren't on the ticket's allowlist, so the scheduler ran the allowlist instead. The feed entry lists `rejectedCommands` and `substitutedCommands` — if the substitution is wrong, update the ticket's `allowedCommands` / `verificationCommands`. |
| `rly` runs stale code after `git pull`                   | Default reads current source via `tsx`, so this shouldn't happen. If you set `RELAY_USE_DIST=1`, run `rly rebuild`.                                                                                                                                                               |
| `rly tui` / `rly gui` fails on first run                 | Install `cargo` (rustup). The auto-build needs it.                                                                                                                                                                                                                                |
| TUI shows no channels                                    | Register at least one workspace with `rly up` and create a channel (or launch a session, which creates one).                                                                                                                                                                      |
| GUI shows stale data                                     | `rly gui --rebuild` to refresh the bundle after a code change.                                                                                                                                                                                                                    |
| Crosslink `no_session` when spawning an associated agent | The GUI spawns a terminal tab on macOS/Linux/Windows. If spawn fails (no supported terminal detected), a system entry lands in the channel feed — run `rly claude` in the repo manually and crosslink will pick it up.                                                            |
| PR watcher never updates                                 | Check `rly pr-status` for errors. Usually a scoping issue on `GITHUB_TOKEN` (needs `repo` scope for private repos).                                                                                                                                                               |

## Next

- `rly welcome` for the 6-step interactive tour (`--reset` to replay).
- `rly inspect-mcp` for the live list of MCP tools exposed to the agent.
- README for the full feature matrix, CLI reference, MCP catalogue, and architecture map.
