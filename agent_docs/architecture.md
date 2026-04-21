# Architecture

Top-level layout of the repo. One line per directory, pointing at the concrete source files to read when you need the full story.

> TODO: expand as needed. When a subsystem keeps confusing agents, write the missing context here and link the relevant files.

## Top level

- **`src/`** — TypeScript orchestrator, CLI, MCP server. Main entry `src/cli.ts`, dispatch in `src/index.ts`.
- **`tui/`** — Rust ratatui dashboard binary. Entry `tui/src/main.rs`, rendering in `tui/src/ui.rs`.
- **`gui/`** — Tauri desktop app. React + Vite frontend in `gui/src/`, Rust backend in `gui/src-tauri/src/lib.rs`.
- **`crates/harness-data/`** — shared Rust types (`src/lib.rs`) consumed by both `tui/` and `gui/`. Reads `~/.relay/` on disk. Mirrors the TS domain shapes.
- **`bin/`** — `rly.mjs` launcher. Runs `src/cli.ts` through `tsx` by default; switches to `dist/` under `RELAY_USE_DIST=1`.
- **`test/`** — vitest tests, directory-mirrored against `src/`.
- **`docs/`** — human-facing deeper walkthroughs.
- **`agent_docs/`** — agent-facing reference (you are here).
- **`scripts/`** — install / migration helpers.

## Inside `src/`

- **`orchestrator/`** — classifier, planner, decomposer, scheduler, approval flow.
- **`agents/`** — Claude and Codex CLI adapters; `command-invoker.ts` for spawning.
- **`channels/`** — `channel-store.ts` owns feed / tickets / decisions; `ao-notifier.ts` bridges to Composio's AO orchestrator.
- **`integrations/`** — AO plugins: tracker (GitHub/Linear), scm (PR watcher), pr-poller, env-mutex.
- **`execution/`** — `executor.ts` abstraction, `local-child-process-executor.ts`, pod executor for k8s.
- **`storage/`** — `HarnessStore` interface in `store.ts`, `FileHarnessStore` and `PostgresHarnessStore` backends.
- **`domain/`** — shared TS types and zod schemas. Canonical source for shapes; Rust side mirrors these.
- **`mcp/`** — MCP server + tool definitions (harness / channel / crosslink tool groups).
- **`crosslink/`** — session discovery, messaging between live agents, hook generation for Claude/Codex.
- **`simulation/`** — `ScriptedInvoker` for deterministic offline testing.
- **`cli/`** — subcommand implementations (`rebuild.ts`, `welcome.ts`, `launcher.ts`, `workspace-registry.ts`, `session-store.ts`, etc.).

## Data flow

1. User types something in `rly claude` (or `rly codex`).
2. MCP server (`src/mcp/`) exposes tools; the CLI's LLM invokes them.
3. Tools write to `ChannelStore` / `HarnessStore`, which write JSON to `~/.relay/`.
4. Orchestrator pipeline runs: classify → plan → decompose → schedule → verify.
5. TUI and GUI watch `~/.relay/` and render from there — no IPC.

## See also

- [`../README.md`](../README.md) has the full feature-facing architecture map.
- [`../docs/getting-started.md`](../docs/getting-started.md) has the mental model for users.
