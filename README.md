# Agent Harness

Local-first scaffolding for a phase-driven coding harness with real Codex and Claude adapters.

## Why this shape

The initial scaffold treats `agent` as a runtime role, not a hard-coded personality explosion. That lets the orchestrator ask for:

- a `planner`
- an `implementer`
- a `reviewer`
- a `tester`

Each task can also carry a specialty such as `ui`, `business_logic`, or `api_crud`. That gives us useful separation without creating a brittle matrix like "UI QA agent", "API QA agent", "CRUD QA agent", and so on before we know we need them.

## Current pieces

- deterministic run and phase state machine
- structured phase plan schema with retry policy and verification commands
- event model and transition guardrails
- agent registry with role + specialty matching
- Codex and Claude CLI adapters behind a common `Agent` interface
- allowlisted verification command execution with captured command-result artifacts
- scripted simulation mode so the harness can be exercised without consuming model calls
- tiny `list-runs` CLI mode for inspecting recent persisted runs without starting a new one
- centralized workspace at `~/.agent-harness/` — register once, use from any repo
- full run persistence with snapshots (`run.json`) and incremental event logs (`events.jsonl`)
- PR lifecycle tracking (branch → commits → PR → checks → review → merge)
- cross-session collaboration via crosslink (discover, message, reply between agent sessions)

## Team quickstart

Install from this repo:

```bash
pnpm install
pnpm build
pnpm link --global
```

Register a repo (run once per repo, stores config centrally at `~/.agent-harness/`):

```bash
cd /path/to/your/repo
agent-harness up
```

Then use the wrapper that matches your normal workflow — from any registered repo:

```bash
agent-harness claude
agent-harness codex
```

List all registered workspaces:

```bash
agent-harness list-workspaces
```

If you want the global command removed later:

```bash
pnpm unlink --global agent-harness
```

## Where it fits today

- `codex` CLI: supported directly through `agent-harness codex`
- `claude` / Claude Code CLI: supported directly through `agent-harness claude`
- `iTerm`: supported by running the wrapper in your normal shell or profile
- `tmux` / `cmux`: supported by running the wrapper in a pane or session the same way you would run `codex` or `claude`
- IDE integrated terminals: supported by running the wrapper in the terminal built into VS Code, JetBrains, Cursor, and similar tools
- Codex desktop app: no first-class direct integration yet; best current path is the CLI wrapper in a terminal alongside the app
- Claude desktop app: no first-class direct integration yet; best current path is Claude Code CLI via `agent-harness claude`

## How teams use it

The wrapper is meant to preserve existing muscle memory:

- if someone normally runs `codex`, they can run `agent-harness codex`
- if someone normally runs `claude`, they can run `agent-harness claude`
- if someone works in iTerm, tmux, cmux, or an IDE terminal, the wrapper works there the same way

The harness MCP server is local stdio only. It adds workspace status, run history, ledgers, and artifact inspection without replacing the rest of your MCP or skill setup.

## Common workflow

- `agent-harness up`: register the current repo in the centralized workspace (`~/.agent-harness/`)
- `agent-harness status`: show workspace paths and recent runs
- `agent-harness list-workspaces`: list all registered workspaces
- `agent-harness doctor`: print workspace status plus native Claude/Codex MCP listings under the wrapper
- `agent-harness inspect-mcp [claude|codex]`: show which MCP servers the wrapped CLI sees
- `agent-harness list-runs`: inspect recent persisted runs without starting a new one
- `agent-harness`: run the local scripted harness flow
- `HARNESS_LIVE=1 agent-harness`: run with live Claude and Codex adapters
- `agent-harness claude`: launch Claude with a generated workspace-local MCP config that attaches the `agent_harness` server without replacing existing MCP sources
- `agent-harness codex`: launch Codex with inline MCP config overrides that attach the `agent_harness` server
- `agent-harness claude --no-harness-mcp`: launch Claude without attaching the harness MCP server
- `agent-harness codex --no-harness-mcp`: launch Codex without attaching the harness MCP server

## Verification and troubleshooting

Use these commands when onboarding a team or debugging a workstation:

```bash
agent-harness status
agent-harness inspect-mcp
agent-harness inspect-mcp codex
agent-harness inspect-mcp claude
agent-harness inspect-mcp codex --no-harness-mcp
agent-harness inspect-mcp claude --no-harness-mcp
agent-harness doctor
```

Helpful checks:

- `inspect-mcp` shows what the wrapped CLI sees with the harness attached
- `inspect-mcp --no-harness-mcp` shows the underlying unwrapped CLI view
- `doctor` gives one combined report for workspace state plus MCP visibility

## Notes for company environments

- local stdio MCP servers are a good fit when only network traffic must go through a company proxy
- `agent-harness` does not proxy or replace your other MCP servers
- `agent-harness codex` adds the harness MCP alongside Codex's existing config
- `agent-harness claude` adds a generated MCP config without using strict isolation, so existing Claude MCP sources can still load

## Architecture

All harness data lives under `~/.agent-harness/`:

```
~/.agent-harness/
  workspace-registry.json          # maps repo paths to workspace IDs
  workspaces/
    <repo-name>-<hash>/            # per-repo workspace
      artifacts/
        runs-index.json
        <runId>/
          run.json                 # full run snapshot
          events.jsonl             # incremental event log
          phase-ledger.json
          pr-lifecycle.json        # PR tracking (if active)
          <artifactId>.json        # command results, classifications
      service-status.json
      claude.mcp.json
  crosslink/                       # cross-session collaboration
    sessions/
    mailboxes/
```

No per-repo `.agent-harness/` directories are created — everything is centralized.

## Next likely steps

1. Let live planner output drive the real plan end-to-end.
2. Run resumption from persisted snapshots.
3. PR lifecycle automation (auto-advance stages from git/GitHub events).
4. Multi-repo orchestration via crosslink.
