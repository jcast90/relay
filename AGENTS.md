# AGENTS.md

Conventions for coding agents (Claude Code, Codex, Cursor, and anything else) working in Relay. This is the short, agent-targeted companion to `CONTRIBUTING.md` — read both if you're new.

For the product pitch and user-facing features, see [`README.md`](./README.md). For the deeper walkthrough, see [`docs/getting-started.md`](./docs/getting-started.md). This doc is about **how to work in the code**, not what the product is.

## Project overview

Relay turns a sentence, a GitHub issue, or a Linear ticket into a running plan of AI-coded work: classifier → planner → decomposer → scheduler → verification → PR watcher. Sessions run inside the user's normal Claude or Codex CLI; Relay wraps them with an MCP server and writes all state (channels, tickets, decisions, crosslink messages) to `~/.relay/` as JSON/JSONL.

The codebase is multi-language by design: **TypeScript orchestrator** (the CLI, MCP server, orchestration pipeline) + **Rust TUI** (`tui/`, ratatui) + **Tauri desktop GUI** (`gui/`, React + Vite frontend with a Rust backend) + a **shared Rust crate** (`crates/harness-data/`) that the TUI and GUI both use to read `~/.relay/`. The three dashboards never talk to each other — they all read the same files on disk.

## Development workflow

Most of the loop is live:

- **TS edits take effect immediately.** `bin/rly.mjs` runs `src/cli.ts` through `tsx`, so `rly …` reflects your source changes on the next invocation. No rebuild.
- **After `git pull` touches `pnpm-lock.yaml` or `Cargo.lock`**, run `rly rebuild`. It runs `pnpm install` first automatically (pass `--skip-install` to skip).
- **Rust TUI changes**: `rly rebuild --tui`.
- **Tauri GUI changes**: `rly gui --dev` for hot-reload, or `rly gui --rebuild` to refresh the `.app` bundle.

Set `RELAY_USE_DIST=1` if you want to exercise the pre-built `dist/` path (marginally faster startup, but stale until `rly rebuild`).

## Verification before pushing

Run these:

```bash
pnpm test && pnpm typecheck && pnpm build
```

If any Rust file under `tui/`, `gui/src-tauri/`, or `crates/` changed:

```bash
cargo check --workspace
```

If any GUI frontend file changed:

```bash
cd gui && pnpm build
```

`pnpm test` is vitest and finishes in under a minute. `pnpm build` runs `tsc -p tsconfig.build.json` and the migration copier — it must pass for the published `dist/` to work.

## Testing conventions

- Vitest, in `test/` mirroring `src/`.
- Live-network tests (real Claude / Codex / GitHub / Linear) sit inside `describe.skip(...)` blocks. Don't enable them in default CI paths.
- **Scripted mode is the default.** With `HARNESS_LIVE` unset, the orchestrator uses `ScriptedInvoker` (`src/simulation/`) — fast, deterministic, no real API calls. Orchestrator tests assume scripted mode; only flip to `HARNESS_LIVE=1` when you're specifically testing adapter plumbing.
- **No snapshot tests for orchestrator output.** Assert on shape — ticket count, status transitions, specific fields — not on stringified blobs. Snapshots turn every legitimate plan-shape change into churn.
- **Two CI tiers.** Fast scripted tier on every PR (`.github/workflows/ci.yml`); integration tier for Postgres / real-git / K8s / live-GitHub runs nightly or on-demand (`.github/workflows/integration.yml`). See [`CI.md`](./CI.md) for the matrix and the secrets an admin needs to add.

## Code style

- Two-space indent, double quotes, semicolons, trailing commas where the language allows them.
- **No linter is enforced in CI.** Run your editor's built-in formatter on files you touch.
- **No drive-by reformats** of files you didn't otherwise touch. Keep the diff focused on the change.
- Imports grouped roughly as node-builtin / dep / local. No unused imports.

## PR hygiene

- **Sub-800 LOC.** PRs above that get split. If the change genuinely can't be split, say why in the PR body.
- **One logical change per PR.** If you touched two unrelated things, open two PRs.
- **Update docs in the same PR** when behaviour or the CLI surface changes. README file-layout tree, MCP tool list, and `crates/harness-data/src/lib.rs` are the places most likely to drift.
- **Bots are welcome, but must be respectful.** No wall-of-text PR bodies. No speculative refactors. No renaming variables the human author didn't touch. Reviewers' time is scarce — don't spend it on noise.
- If the change was AI-assisted, keep the `Co-Authored-By:` footer on the commits.

## Where things live

```
src/
  cli.ts                  # entry point (bin/rly.mjs → tsx → here)
  index.ts                # CLI dispatch (welcome, claude, codex, board, …)
  cli/                    # CLI subcommands + launchers (tui, gui, rebuild, welcome, workspace, session)
  orchestrator/           # classifier, planner, decomposer, scheduler, approval
  agents/                 # Claude/Codex CLI adapters, registry, invocation
  channels/               # ChannelStore (feed / decisions / tickets / runs), ao-notifier
  integrations/           # AO plugins — tracker, scm, pr-poller, env-mutex
  execution/              # executor abstraction, verification-runner, local child-process executor
  storage/                # HarnessStore interface + file / postgres backends
  domain/                 # shared TS types + zod schemas
  mcp/                    # MCP server + tool definitions
  crosslink/              # session discovery, messaging, hook generation
  simulation/             # ScriptedInvoker for scripted demo mode
  tui/                    # thin TS shim that launches the ratatui binary

tui/                      # ratatui dashboard (Rust)
gui/                      # Tauri desktop app (React + Vite frontend, Rust backend)
crates/harness-data/      # shared Rust types consumed by tui/ + gui/
```

Files an agent will commonly touch: `src/orchestrator/*.ts` for pipeline logic, `src/channels/channel-store.ts` for feed/ticket state, `src/mcp/*.ts` for tool definitions, `src/domain/*.ts` for shared shapes.

## Cross-dashboard contract

This is where agents quietly break things:

- **Change a shape in `src/domain/` → update `crates/harness-data/src/lib.rs` in the same PR.** The TUI and GUI deserialize JSON via serde against those Rust structs; if a new required field appears and the Rust side doesn't know about it, the dashboards silently drop rows or fail to parse. This is the "it compiled but the TUI shows nothing" class of bug.
- **Add an MCP tool → update the README's MCP list + `rly inspect-mcp` is authoritative.** People grep the README counts.
- **Change the `~/.relay/` file layout → update the README file-layout tree + `docs/getting-started.md` in the same PR.**

## File-safety expectations

- Anything persisted to `~/.relay/` is **atomic**: write to a temp file, then rename. No partial writes. `channel-store.ts` and `file-store.ts` already do this — follow the pattern.
- `channel-store.postEntry` appends to `feed.jsonl`. The feed is **append-only** — never rewrite it. If you need to reinterpret an entry, post a correction entry rather than mutating history.
- `HarnessStore` writes are mirrored through an in-memory coordination layer for cross-agent `LISTEN/NOTIFY`, but **disk is the source of truth**. If memory and disk disagree, disk wins on next read.
- Tests use per-test tmp dirs. **Never `rm -rf` outside your own tmp dir.** No test should touch a real `~/.relay/`.

## Things to watch out for

- **Subprocess env is sanitized by default.** `NodeCommandInvoker` strips the parent process's secrets before spawning any child (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, AWS creds, anything matching `SECRET_NAME_PATTERN`) and forwards only a small exact-match whitelist + the `LC_*`/`HARNESS_*`/`RELAY_*`/`AGENT_HARNESS_*` prefix families. If a caller legitimately needs a token in the child, opt-in per-name via `passEnv: ["GITHUB_TOKEN", …]` on the `CommandInvocation`. See `SECRET_NAME_PATTERN` in `src/agents/command-invoker.ts`.
- **`rly serve` hard-stops on non-loopback + no token.** Validation lives in `src/mcp/serve-validation.ts` (pure function, unit-tested). Escape hatch for genuine remote-access setups is `--allow-unauthenticated-remote`, but prefer `--token`. Loopback + no token only warns — that's the default dev workflow.
- **`process.env` mutation in AO plugin loading** goes through `withEnvOverride` in `src/integrations/plugin-env-mutex.ts`. It is **not reentrant** — two concurrent callers corrupt each other's env snapshot. Use the mutex; don't poke `process.env` yourself in tracker/scm code.
- **Agent spawning ("open a terminal tab for the associated repo") lives in the GUI** (`gui/src-tauri/src/lib.rs`), not in `src/`. Platform branches: macOS uses `osascript` against Terminal.app (window/tab ids tracked for targeted close); Linux probes `$TERMINAL` then a chain (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`, `alacritty`, `kitty`, `wezterm`) via `which`; Windows prefers `wt.exe`, falls back to `powershell.exe` then `cmd.exe`. Linux/Windows don't track window ids — kill falls back to SIGTERM (or `taskkill /T /F`) on the crosslink session matching the repo path. If no supported terminal is detected, `spawn_agent` returns an error **and** posts a `system` channel-feed entry telling the user to `rly claude` in the repo manually. The Linux/Windows paths are compile-checked via `cargo check --workspace` but only smoke-tested in CI — real-device testing on those platforms is the integration gate before release.
- **`channel-store.postEntry` is append-only** — see above. Feed re-rendering works by reading the whole `feed.jsonl`, so never mutate it in place.
- **`HarnessStore` writes mirrored, disk authoritative** — see above. If you're adding a new piece of state, add it to the interface in `src/storage/store.ts` first, then both backends.
- **`HARNESS_LIVE` unset = scripted mode.** Tests assume this. If an orchestrator test is flaky, first check whether something is accidentally reading `process.env.HARNESS_LIVE` from the host shell.
- **Decisions are one-file-per-id** (`channels/<id>/decisions/<decisionId>.json`). Writes are temp-rename atomic. Don't batch decisions into a single file.

## Asking for help

When the codebase is unclear, **read the adjacent tests first** — `test/` mirrors `src/`, so whatever you're looking at usually has a test file that spells out the expected shape. If still stuck, leave a `TODO:` with a one-line explanation and ship a smaller change rather than guessing your way through.

Don't fabricate behaviour. If a function's intent isn't obvious from its signature, its tests, and its call sites, say so in the PR body.

## Deeper reference

For architecture deep-dives, data-model catalogues, and testing patterns, see **[`agent_docs/`](./agent_docs/)**. That directory is agent-targeted reference material — grep it when this file didn't answer your question. `docs/` is for humans.
