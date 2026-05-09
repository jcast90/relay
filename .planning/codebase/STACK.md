# Technology Stack

**Analysis Date:** 2026-05-09

Relay is a multi-language project: a TypeScript orchestrator (the `rly` CLI, MCP server, and orchestration pipeline) plus a Rust TUI (`tui/`), a Tauri desktop GUI (`gui/`, React + Vite frontend with a Rust backend), and a shared Rust crate (`crates/harness-data/`) that the TUI and GUI both consume to read `~/.relay/`. All three dashboards read the same on-disk JSON/JSONL files; they never talk to each other directly.

## Languages

**Primary:**
- **TypeScript** (ES2022, strict, `module: ES2022`, `moduleResolution: Bundler`) — the orchestrator, CLI, MCP server, AO integrations, channel store, simulator. See `tsconfig.json`. Source under `src/`, tests under `test/` mirroring `src/`.
- **Rust** (edition 2021, workspace at `Cargo.toml`) — the ratatui TUI (`tui/`), the Tauri GUI backend (`gui/src-tauri/`), and the shared `harness-data` crate (`crates/harness-data/`). Workspace members are `crates/harness-data`, `tui`, `gui/src-tauri`.

**Secondary:**
- **TypeScript / React** (`gui/src/`) — Tauri frontend; uses `@tauri-apps/api` `invoke()` to call Rust commands.
- **SQL** (`src/storage/migrations/001_init.sql`) — Postgres schema for the placeholder `PostgresHarnessStore` (only the file backend ships today; see `src/storage/factory.ts`).
- **Bash** (`install.sh`, `scripts/copy-migrations.mjs` is `.mjs`) — installer + copy helper.

## Runtime

**Environment:**
- **Node.js** for the orchestrator. `package.json` declares no `engines` pin; `@types/node` is `^22.15.30`, which is the practical floor. The `bin/rly.mjs` launcher uses `node:child_process`, `node:fs`, `node:url`, `import.meta.url` — all stable in modern Node.
- **Rust toolchain** (cargo, edition 2021) for `tui/` and `gui/src-tauri/`. `cargo check --workspace` is the verification gate per `AGENTS.md`.
- **System binaries** the orchestrator shells out to:
  - `claude` (Anthropic Claude Code CLI) — invoked from `src/agents/cli-agents.ts::ClaudeCliAgent`.
  - `codex` (OpenAI Codex CLI) — invoked from `src/agents/cli-agents.ts::CodexCliAgent`.
  - `gh` (GitHub CLI) — used by the AO `@aoagents/ao-plugin-scm-github` plugin and by `src/integrations/pr-reviewer.ts`.
  - `tsx` — bundled in `node_modules/.bin/tsx`; `bin/rly.mjs` execs it to run `src/cli.ts` without a build.
  - `cargo` — invoked from `src/cli/launch-gui-tui.ts` and `src/cli/rebuild.ts` to (re)build the TUI / GUI.

**Package Manager:**
- **pnpm** (lockfile `pnpm-lock.yaml` present at repo root and at `gui/pnpm-lock.yaml`). `install.sh` and `AGENTS.md` both call `pnpm install`. `pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm format` are the canonical scripts.

## Frameworks

**Core (TypeScript orchestrator):**
- **`zod` `^3.24.4`** (`package.json`) — runtime validation for every shared shape under `src/domain/`. Examples: `AgentResultSchema` and `agentResultJsonSchema` in `src/domain/agent.ts`; `ProviderProfileSchema` in `src/domain/provider-profile.ts`; ticket / channel / phase-plan schemas. Zod schemas are converted to JSON schema and handed to the Claude CLI as `--json-schema` so the model returns structured output (`src/agents/cli-agents.ts`).
- **`tsx` `^4.20.6`** — runs `src/cli.ts` directly so source edits take effect without a build (`bin/rly.mjs`).
- **`pg` `^8.20.0`** — Postgres client used by the unfinished `PostgresHarnessStore` (`src/storage/postgres-store.ts`); not on the default code path. `getHarnessStore()` returns the file backend regardless of `HARNESS_STORE` today.

**Core (Rust TUI — `tui/Cargo.toml`):**
- **`ratatui = "0.29"`** — terminal UI framework.
- **`crossterm = "0.28"`** — terminal driver (raw mode, mouse, alt-screen).
- **`arboard = "3"`** — clipboard access (copy from the chat view).
- **`harness-data` (path = `../crates/harness-data`)** — the shared schema crate that maps `~/.relay/` JSON onto Rust structs.

**Core (GUI — `gui/src-tauri/Cargo.toml` + `gui/package.json`):**
- **`tauri = "2.0"`** — desktop shell (window/system, IPC `invoke` bridge to Rust).
- **`tauri-plugin-shell = "2.0"`** — opens external commands and URLs.
- **`tauri-plugin-dialog = "2.0"`** — native open/save dialogs.
- **`notify = "6"`** — filesystem watching (declared as a dep; backs filesystem-event-driven UI updates).
- **React `^18.3.1` + `react-dom` `^18.3.1`** (`gui/package.json`) — the renderer.
- **Vite `^5.4.10`** (`gui/vite.config.ts`) — frontend dev server + bundler. Pinned to `127.0.0.1:1420`; `envPrefix: ["VITE_", "TAURI_"]`.
- **`@vitejs/plugin-react` `^4.3.3`** — React plugin for Vite.
- **`react-markdown` `^10.1.0` + `remark-gfm` `^4.0.1`** — message rendering in chat.
- **`@tauri-apps/api` `^2.1.1`** — JS bindings for the Tauri IPC bridge (used in `gui/src/api.ts`).
- **`@tauri-apps/plugin-shell` / `@tauri-apps/plugin-dialog`** — JS sides of the corresponding Rust plugins.

**Shared Rust crate (`crates/harness-data/Cargo.toml`):**
- **`serde = "1"` (with `derive`) + `serde_json = "1"`** — JSON serialization with `#[serde(rename_all = "camelCase")]` matching the TS writers' field names.
- **`dirs = "6"`** — locates `~/.relay/`.
- **`chrono = "0.4"`** — timestamp parsing for the JSON files written by TS (`registeredAt`, `lastAccessedAt`, etc.).
- **`sha2 = "0.10"`** — workspace-id derivation (`<basename>-<sha256[..12]>`).

**Testing:**
- **`vitest` `^3.2.4`** — TS test runner. Config: `vitest.config.ts`. Tests live in `test/` mirroring `src/`. Live-network tests sit inside `describe.skip(...)` blocks per `AGENTS.md`.
- **`vitest` `^3.2.4` + `jsdom` `^29.0.2` + `@testing-library/react`/`-dom`/`user-event`** — GUI frontend tests under `gui/`. Run with `pnpm test:gui`.
- **`tempfile = "3"`** (Rust dev-dep, in both `crates/harness-data` and `gui/src-tauri`) — temp-dir fixtures.
- `cargo check --workspace` — Rust gate run from the repo root before pushing if any Rust file changed.

**Build/Dev:**
- **TypeScript `^5.9.3`** (`tsc -p tsconfig.build.json` for the published `dist/`; `tsc --noEmit` for `pnpm typecheck`).
- **Prettier `^3.8.3`** — formatter, enforced in CI (`pnpm format:check` job blocks merges). Config: `.prettierrc` (semi, double-quotes, trailing-comma `es5`, 2-space indent, 100 col).
- **`@changesets/cli` `^2.31.0`** — version + changelog management. Config in `.changeset/`. `scripts/sync-versions.mjs` keeps the Rust `Cargo.toml` versions in step (run from `changeset-version`).
- **`scripts/copy-migrations.mjs`** — copies `src/storage/migrations/*.sql` into `dist/` so the placeholder Postgres backend's schema ships with the npm package.
- **`tauri-build = "2.0"`** (`gui/src-tauri` build-dep) + `gui/src-tauri/build.rs` — Tauri's compile-time codegen step.
- **`build.rs`** in `tui/` — TUI-side build hook.

## Key Dependencies

**Critical (orchestration runtime — npm):**
- **`@aoagents/ao-core` `0.2.5`** — types for the AO plugin surface (`Tracker`, `SCM`, `ProjectConfig`, `Session`, `PRInfo`). Imports must be confined to `src/integrations/tracker.ts` and `src/integrations/scm.ts` per the comments in those files; no other module should import from `@aoagents/*`.
- **`@aoagents/ao-plugin-tracker-github` `0.2.5`** — GitHub Issues tracker plugin. Reads `GITHUB_TOKEN` at construction time. Wrapped by `createTracker("github")` in `src/integrations/tracker.ts`.
- **`@aoagents/ao-plugin-tracker-linear` `0.2.5`** — Linear issues tracker plugin. Reads `LINEAR_API_KEY` at construction time. Wrapped by `createTracker("linear")` (same file).
- **`@aoagents/ao-plugin-scm-github` `0.2.5`** — PR detect / CI / review-decision / comment surface for GitHub. Shells out to `gh`. Wrapped by `createScm("github")` in `src/integrations/scm.ts`.
- **`zod` `^3.24.4`** — runtime validation for every cross-process payload (agent result, classification, ticket plan, provider profile, channel shape).
- **`pg` `^8.20.0`** — only used by `src/storage/postgres-store.ts`, which is currently behind a fall-back warning in `src/storage/factory.ts::buildHarnessStore`.

**Critical (Rust):**
- **`ratatui = "0.29"` + `crossterm = "0.28"`** — TUI surface.
- **`tauri = "2.0"`** — GUI desktop shell.
- **`harness-data` (workspace path)** — single source of truth for `~/.relay/` shapes consumed by both TUI and GUI. **When a TS shape under `src/domain/` changes, `crates/harness-data/src/lib.rs` must change in the same PR** (see `AGENTS.md`'s "Cross-dashboard contract").
- **`serde / serde_json`** — every Rust struct that mirrors a TS shape uses `#[serde(rename_all = "camelCase")]`.

**Infrastructure:**
- **MCP transport (custom)** — `src/mcp/server.ts` implements an MCP JSON-RPC handler and `src/mcp/http-transport.ts` provides an SSE transport that "mirrors the MCP SSE transport shipped by `@modelcontextprotocol/sdk`" (per the comment in that file). The repo deliberately does not depend on the official SDK; the protocol is hand-rolled. `rly serve` exposes the MCP surface over HTTP+SSE; `rly inspect-mcp` is the authoritative tool list.
- **Streaming JSON parsing** — `ClaudeCliAgent.invokeStreaming` (`src/agents/cli-agents.ts`) parses Claude CLI `stream-json` lines (`type: "assistant"` / `type: "result"`) and feeds tool-use blocks to a per-line callback. Mirrored on the Rust side by the TUI worker (`tui/src/main.rs`) and `crates/harness-data/src/tool_activity.rs`.

## Configuration

**Environment variables (read by the orchestrator):**

Operator-facing:
- `HARNESS_LIVE` — when unset, the orchestrator uses `ScriptedInvoker` (`src/simulation/`); `=1` switches to live `claude` / `codex` calls. Tests assume scripted mode.
- `HARNESS_PROVIDER` — default agent provider (`claude` | `codex`); read in `src/index.ts:376`.
- `HARNESS_QUIET` / `RELAY_QUIET` / `NO_COLOR` — output verbosity.
- `HARNESS_STORE` — selects the storage backend; values other than `"file"` log a warning and fall back to file (`src/storage/factory.ts`). Postgres / SQLite branches are placeholders.
- `RELAY_USE_DIST` — when `=1`, `bin/rly.mjs` runs the pre-built `dist/cli.js` instead of going through `tsx`.
- `RELAY_HOME` — overrides `~/.relay/` root (`src/cli/paths.ts`).
- `RELAY_PORT` / `RELAY_TOKEN` — `rly serve` HTTP MCP bind port + bearer token.
- `RELAY_AUTO_APPROVE` — when truthy, dispatched agents run with `--dangerously-skip-permissions` (Claude) / `--sandbox workspace-write --ask-for-approval never` (Codex).
- `RELAY_NO_UPDATE_NUDGE` — silences the in-CLI update nudge.
- `RELAY_TUI_INSTALL_DIR` — override for the Rust TUI binary location.
- `RELAY_PROVIDER` — additional provider selection knob.
- `RELAY_AGENT_ALIAS` / `RELAY_SESSION` / `RELAY_SESSION_ID` — set on dispatched subprocesses so the MCP server knows which session is calling.
- `CLAUDE_BIN` — override path to the `claude` binary.
- `TMUX` — detected for tmux-aware launch behavior.

Provider auth (forwarded into spawned `claude` / `codex` subprocesses via the `passEnv` opt-in in `src/agents/command-invoker.ts`; never read by Relay itself):
- Claude (see `CLAUDE_PASS_ENV` in `src/agents/cli-agents.ts`): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `CLOUDSDK_CORE_PROJECT`.
- Codex (see `CODEX_PASS_ENV` in same file): `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `CODEX_HOME`.

External-service tokens (used directly by Relay or the AO plugins):
- `GITHUB_TOKEN` — read by `@aoagents/ao-plugin-tracker-github`, `@aoagents/ao-plugin-scm-github` (via `gh`), the GH Projects v2 client (`src/integrations/github-projects/client.ts`), and forwarded explicitly via `passEnv: ["GH_TOKEN", "GITHUB_TOKEN"]` in `src/integrations/pr-reviewer.ts`.
- `LINEAR_API_KEY` — read directly by the Linear mirror (`src/integrations/linear-mirror.ts`) and by `@aoagents/ao-plugin-tracker-linear`. Surfaced via `process.env.LINEAR_API_KEY` in `src/index.ts:1146` for ingest CLI paths.
- `COMPOSIO_API_KEY` — only checked in `src/cli/welcome.ts:272` as an alternative to `LINEAR_API_KEY` for onboarding completeness.

**Subprocess env sanitization:**
Spawned children (claude, codex, gh, …) get a heavily filtered env. `NodeCommandInvoker` (`src/agents/command-invoker.ts`) starts with the `DEFAULT_ENV_WHITELIST` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TZ`, `TMPDIR`, `TEMP`, `TMP`, `TERM`, `PWD`, `NODE_ENV`) plus the prefix families `LC_*`, `HARNESS_*`, `RELAY_*`. Anything matching `SECRET_NAME_PATTERN` (matches `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, etc.) is stripped even if added back to the whitelist. Per-call `passEnv: [...]` opts a name back in by exact match.

**On-disk config files:**
- `~/.relay/` — root for all persistent state. JSON for documents, JSONL for append-only logs. Atomic via tmp-file + rename (`channel-store.ts`, `file-store.ts`).
- `~/.relay/config.env` — operator-supplied env exports (sourced by the user's shell). Scaffolded from `~/.relay/config.env.template` by `src/cli/welcome.ts::scaffoldConfigEnv`. Mode 0600 because it holds tokens.
- `~/.relay/onboarded.json` — first-run guard.
- `~/.relay/workspace-registry.json` — repo registry (`src/cli/workspace-registry.ts`); also read/write by `crates/harness-data/src/lib.rs::WorkspaceRegistry`.
- `~/.relay/channels/<id>/feed.jsonl` — per-channel append-only feed.
- `~/.relay/channels/<id>/decisions/<decisionId>.json` — one-file-per-id decision records (atomic rename).

No `.env` or `.env.example` files are present at the repo root.

**TypeScript / build configs:**
- `tsconfig.json` — type-check only (`noEmit: true`); `target/module: ES2022`; `moduleResolution: Bundler`; `strict: true`; `types: ["node", "vitest/globals"]`; covers `src/` and `test/`.
- `tsconfig.build.json` — emits `dist/` for the published npm package.
- `vitest.config.ts` — the orchestrator vitest config.
- `gui/tsconfig.json`, `gui/vite.config.ts`, `gui/vitest.config.ts` — GUI frontend configs.

## Platform Requirements

**Development:**
- Node 22 (per `@types/node`) + pnpm.
- Rust toolchain via rustup (the GUI/TUI launcher in `src/cli/launch-gui-tui.ts:33` points the user at `https://rustup.rs`).
- `claude` and/or `codex` CLI installed locally for live runs. `CLAUDE_BIN` overrides the discovered path.
- `gh` CLI for any GitHub-touching path (PR detection, CI status, PR comments).
- Optional: macOS `osascript` (already on macOS) for `gui/src-tauri/src/lib.rs::spawn_agent` to open Terminal.app windows.

**Production / distribution:**
- Published as the npm package `@jcast90/relay` exposing the `rly` bin (`bin/rly.mjs`). Files shipped: `bin`, `dist`, `src`, `LICENSE`, `README.md`.
- The Rust TUI is built locally via `rly rebuild --tui` (or `pnpm tui:build`); it is not currently distributed as a precompiled binary in the npm package — `RELAY_TUI_INSTALL_DIR` lets the user point Relay at one.
- The Tauri GUI is bundled via `pnpm gui:build` (`cd gui && pnpm tauri build`) into a per-platform `.app` / installer.

**CI:**
- `.github/workflows/ci.yml` — fast scripted tier on every PR (vitest + typecheck + build + format-check; cargo check when Rust changes).
- `.github/workflows/integration.yml` — integration tier (Postgres / real-git / live-GitHub) nightly or on-demand.
- `.github/workflows/release.yml` — npm publish via Changesets.
- `.github/workflows/changesets.yml` — version PR automation.

---

*Stack analysis: 2026-05-09*
