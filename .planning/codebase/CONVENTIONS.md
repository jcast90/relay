# Coding Conventions

**Analysis Date:** 2026-05-09

Authoritative sources: [`AGENTS.md`](../../AGENTS.md) (agent-targeted) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md) (human-targeted). The conventions below were verified by sampling actual code under `src/`, `gui/src/`, `tui/src/`, and `crates/`.

Relay is a multi-language repo: TypeScript orchestrator (`src/`) + Rust ratatui dashboard (`tui/`) + Tauri desktop GUI (`gui/`, React + Vite frontend with a Rust backend in `gui/src-tauri/`) + a shared Rust crate (`crates/harness-data/`) consumed by both `tui/` and `gui/`.

## Naming Patterns

**Files (TypeScript):**
- `kebab-case.ts` for source modules. Examples: `src/orchestrator/ticket-router.ts`, `src/channels/channel-store.ts`, `src/agents/command-invoker.ts`, `src/integrations/github-projects/url-parser.ts`.
- Test files mirror source path under `test/` and append `.test.ts`. Example: `src/orchestrator/ticket-router.ts` ↔ `test/orchestrator/ticket-router.test.ts`.
- Integration suites get an `.integration.test.ts` suffix and gate on env (e.g. `test/storage/postgres-store.integration.test.ts`).

**Files (React / GUI frontend):**
- `PascalCase.tsx` for components: `gui/src/components/Sidebar.tsx`, `gui/src/components/NewChannelModal.tsx`, `gui/src/components/PromptModal.tsx`.
- Component tests sit beside the component as `PascalCase.test.tsx`: `gui/src/components/Sidebar.test.tsx`. (Different from the orchestrator, where tests live under `test/`.)
- Lib helpers in `gui/src/lib/` use `camelCase.ts` (`firstRun.ts`, `appearance.ts`, `dialogs.ts`, `mentions.ts`).

**Files (Rust):**
- `snake_case.rs`. Examples: `tui/src/main.rs`, `tui/src/install_drift.rs`, `crates/harness-data/src/tool_activity.rs`.
- Workspace crates: `harness-data`, `relay-tui`, `relay-gui`. Hyphenated package names with underscored `[lib] name = "relay_gui_lib"` where Rust requires it.

**Functions / variables / types (TypeScript):**
- `camelCase` for functions and variables: `classifyByHeuristic`, `buildHeuristicClassification`, `decisionStoreId`.
- `PascalCase` for classes, interfaces, type aliases, and zod schemas: `ChannelStore`, `OrchestratorV2`, `TicketLedgerEntry`, `TicketDefinitionSchema`, `ScriptedInvoker`.
- Zod schemas are named `<Type>Schema` and the inferred type is exported alongside via `z.infer`. See `src/domain/ticket.ts:9–35`.
- Orchestrator stage classes / entry points: `Classifier`, `OrchestratorV2`, `TicketScheduler`, `TicketRouter`, `TicketRunner`, `RepoAdminPool`, `WorkerSpawner`. The pipeline order (`classifier → planner → decomposer → scheduler → router → runner`) is reflected in filenames under `src/orchestrator/`.
- Channel-store entities follow `Channel<Thing>`: `ChannelEntry`, `ChannelMember`, `ChannelRef`, `ChannelPr`, `ChannelRunLink`, `ChannelStatus`. Builders are `build<Thing>Id` (`buildChannelId`, `buildEntryId`, `buildDecisionId`).

**Functions / types (Rust):**
- `snake_case` functions, `PascalCase` types/enums (`WorkspaceRegistry`, `RunIndexEntry`, `Tab`, `FocusPanel`).
- Serde structs use `#[serde(rename_all = "camelCase")]` so JSON written by the TS side round-trips into Rust unchanged. See `crates/harness-data/src/lib.rs:17`.

## Code Style

**Formatting (TypeScript / TSX / Markdown):**
- Prettier, configured in `.prettierrc`:
  ```json
  { "semi": true, "singleQuote": false, "trailingComma": "es5",
    "tabWidth": 2, "printWidth": 100, "arrowParens": "always" }
  ```
- Two-space indent, double quotes, semicolons, trailing commas where the language allows.
- Run `pnpm format` before pushing. `pnpm format:check` verifies.
- **Prettier is enforced in CI** by the `format-check` job in `.github/workflows/ci.yml`. The job runs `pnpm dlx prettier --check 'src/**/*.{ts,tsx}' 'test/**/*.{ts,tsx}' 'gui/src/**/*.{ts,tsx}' 'scripts/**/*.{ts,mts}' '*.md' 'docs/**/*.md'` and blocks merges on drift.
- **No drive-by reformats** of files unrelated to the change. Keep diffs focused.

**Formatting (Rust):**
- No `rustfmt.toml` or `clippy.toml` checked in. `cargo fmt` defaults are accepted; `cargo clippy` is not run in CI today — only `cargo check --workspace --locked` and `cargo test --workspace` (`.github/workflows/ci.yml` `rust-check` job).

**TypeScript compiler:**
- `tsconfig.json`: `target: ES2022`, `module: ES2022`, `moduleResolution: Bundler`, `strict: true`, `forceConsistentCasingInFileNames: true`, `noEmit: true`. The `dist/` build uses `tsconfig.build.json`.
- ESM throughout (`"type": "module"` in `package.json`). Imports include the `.js` extension even though source is `.ts` (Node-ESM resolution rule). See any file in `src/orchestrator/`.

**GUI-specific guard:**
- `format-check` also greps `gui/src` for `window.prompt(`, `window.confirm(`, `window.alert(` and fails the job if any match. Tauri v2 WKWebView no-ops these — route through `PromptModal` or `gui/src/lib/dialogs.ts`. See `.github/workflows/ci.yml:114–127`.

## Import Organization

**Order (TypeScript):**
1. Node built-ins (`node:fs/promises`, `node:path`, `node:os`)
2. Third-party deps (`zod`, `vitest`, etc.)
3. Local relative imports (`../domain/...`, `./classifier.js`)

Examples: `src/channels/channel-store.ts:1–26`, `test/orchestrator/ticket-router.test.ts:10–33`.

- No unused imports.
- No path aliases — relative paths only. ESM `.js` extension on every relative import.
- Type-only imports use `import type { ... }` (e.g. `src/orchestrator/orchestrator-v2.ts:1`).

**Order (Rust):**
- Standard ordering: external crates, then `std::`, then local. See `tui/src/main.rs:1–23`. Module declarations (`mod install_drift;`) at the top of `main.rs` / `lib.rs`.

## Error Handling

**TypeScript:**
- Default pattern: `throw new Error("…")` with a contextual message. Examples:
  - `src/orchestrator/repo-admin-session.ts:281,549,578,770,812`
  - `src/agents/cli-agents.ts:329,409,509,514`
  - `src/orchestrator/worker-spawner.ts:277,311`
- No custom `Error` subclasses in the orchestrator hot path; failures surface as message-bearing `Error`s and are categorized at the boundary via `FailureClassification` (`src/domain/agent.ts`).
- Best-effort, non-fatal failures are logged and swallowed with `console.warn("[<module>] …")`. See `src/orchestrator/orchestrator-v2.ts:157,185,382,469,595`. The `[<module>]` prefix is consistent across the orchestrator.
- Boundary input is validated with zod (`src/domain/ticket.ts:54 parseTicketPlan`). Domain types are derived via `z.infer<typeof Schema>` so the runtime check and the static type stay in sync.

**Rust:**
- `anyhow` and `thiserror` are present transitively in `Cargo.lock` but **not used in first-party source**. The Rust crates (`tui/`, `gui/src-tauri/`, `crates/harness-data/`) lean on:
  - `Result<T, String>` for Tauri command handlers (`gui/src-tauri/src/lib.rs:25,168,179,…`). `String` errors cross the IPC boundary cleanly as JSON.
  - `Option<T>` returns where the call is intrinsically fallible and the caller doesn't need a reason (`tui/src/main.rs:32 cli_json` returns `Option<serde_json::Value>` and silently maps failures to `None`).
  - `.expect("<reason>")` for invariants whose violation should crash, with a short explanation message: `gui/src-tauri/src/lib.rs:1774 .expect("CANCELLED_STREAMS poisoned")`.
  - `.unwrap()` only inside `#[cfg(test)]` blocks.
- If new error-rich crates need richer types, prefer `thiserror`-derived enums for library code and avoid `anyhow` in public APIs. There is no convention enforcing this yet — flag it in PR review.

## Logging

**TypeScript:**
- `console.warn` / `console.error` with a bracketed module prefix: `console.warn("[orchestrator] channel creation failed (runId=${run.id}): ${message}")`.
- No structured logger (no `pino`, `winston`, etc.). Stdout/stderr is the surface; the channel feed (`feed.jsonl`) is the persistent record.
- Channel events are posted via `ChannelStore.postEntry` (`src/channels/channel-store.ts`), not via a logger.

**Rust:**
- No `tracing` or `log` integration in TUI/GUI today. Errors propagate to the caller as `Result<_, String>` and the GUI surfaces them in the React layer.

## Comments

**Doc comments:**
- TSDoc (`/** … */`) on exported classes, public methods, and non-obvious option fields. The orchestrator and channel-store source is heavily commented — see `src/orchestrator/orchestrator-v2.ts:29–45` and `src/channels/channel-store.ts:57–82`.
- Inline `//` comments explain *why*, not *what*. Long-form rationale (race conditions, atomic-rename gotchas, backwards-compat constraints) is the norm — example: `src/channels/channel-store.ts:28–55` documents the per-channel lock map and the tmp-file counter rationale.
- `TODO:` is allowed when context is incomplete; AGENTS.md says "leave a `TODO:` with a one-line explanation and ship a smaller change rather than guessing."

**Rust:**
- `///` doc comments on public items. Internal rationale uses `//` blocks (e.g. `crates/harness-data/src/lib.rs:11–16`).
- `#[allow(dead_code)]` is used sparingly for fields the Rust side deserializes but doesn't read — keeping the wire shape complete (`crates/harness-data/src/lib.rs:47`).

## Function Design

- Functions are typed at the boundary; internal types are inferred. Domain types ride on zod schemas.
- Orchestrator stage classes expose a single primary entry point (`OrchestratorV2.run`, `TicketScheduler.enqueue`, `TicketRunner.drainOnce`) and keep state internal. Concurrency primitives (locks, in-flight maps) live as private module-level state when they protect process-wide invariants — see the per-channel lock map in `src/channels/channel-store.ts:35`.
- Side effects to disk go through atomic temp-file + rename. `src/channels/channel-store.ts` and `src/storage/file-store.ts` set the pattern; new code that writes under `~/.relay/` MUST follow it.

## Module Design

- ESM modules; `index.ts` only at the package root (`src/index.ts`). No barrel files inside subdirectories — callers import from the specific module (`src/channels/channel-store.js`, not `src/channels/index.js`).
- Cross-dashboard contract: any change to a TS shape under `src/domain/` MUST be mirrored in `crates/harness-data/src/lib.rs` in the same PR. Otherwise the TUI/GUI silently drop fields. AGENTS.md flags this as the most common "compiled but the TUI shows nothing" bug.

## React / GUI Frontend Conventions

**Component shape:**
- Function components only. Props typed via local `type Props = { … }` (no `React.FC`). See `gui/src/components/Sidebar.tsx:7–22`.
- Hooks-based state — `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`. No Redux, no Zustand, no React Query. Top-level state lives in `gui/src/App.tsx` and flows down via props (see `App.tsx:16–47`).
- `localStorage` is read/written directly with `try/catch` for blocked-storage cases (`App.tsx:28–34,49–55`).
- All Tauri IPC goes through `gui/src/api.ts` (`api.<command>(...)` style). Components never call `invoke` directly.

**State management:**
- Local component state for UI-local concerns; lifted state in `App.tsx` for cross-pane data (channels, selected channel, sessions, settings). `refreshTick` integer is the manual revalidation knob — bumped via `refresh()` callback to retrigger effects.
- No global store. The shared truth lives on disk under `~/.relay/`; the GUI re-reads via Tauri commands when `refreshTick` increments or a 5s `setInterval` fires.

**CSS strategy:**
- Plain CSS, no CSS-in-JS, no Tailwind. Entry stylesheet `gui/src/styles.css` imports design tokens from `gui/src/styles/tokens.css` and per-feature styles (`mentions.css`).
- Theme uses CSS custom properties (`var(--color-ink-deepest)`, `var(--font-ui)`, `var(--space-2)`). Component class names are kebab-case.

**Dialogs / prompts:**
- `window.prompt`, `window.confirm`, `window.alert` are **banned** by the format-check CI job (Tauri v2 WKWebView no-ops them). Use `PromptModal` (`gui/src/components/PromptModal.tsx`) or the `confirmAction` / `notifyError` helpers from `gui/src/lib/dialogs.ts`.

## File-Safety Conventions

- Anything written to `~/.relay/` is **atomic** (temp file + rename). Patterns to follow live in `src/channels/channel-store.ts` and `src/storage/file-store.ts`.
- `feed.jsonl` is **append-only**. Never rewrite. To correct an entry, post a correction entry via `channel-store.postEntry`.
- Decisions are **one file per id** at `channels/<id>/decisions/<decisionId>.json`. Don't batch.
- Tests use per-test tmp dirs (`mkdtemp(join(tmpdir(), "..."))`). **Never `rm -rf` outside your own tmp dir.** No test should touch a real `~/.relay/`.
- `process.env` mutation in AO plugin loading goes through `withEnvOverride` in `src/integrations/plugin-env-mutex.ts` — it is **not reentrant**.
- `NodeCommandInvoker` (`src/agents/command-invoker.ts`) sanitizes child env by default, stripping `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, AWS creds, and anything matching `SECRET_NAME_PATTERN`. Only `LC_*`, `HARNESS_*`, `RELAY_*` and an explicit allowlist pass through. Opt-in per token via `passEnv: ["GITHUB_TOKEN", …]` on `CommandInvocation`.

## PR Hygiene

From AGENTS.md and CONTRIBUTING.md, enforced by reviewers (not CI):

- **Sub-800 LOC.** PRs above that get split. If genuinely indivisible, justify in the body.
- **One logical change per PR.** Two unrelated touches → two PRs.
- **No drive-by reformats** of files the change didn't otherwise touch.
- **No speculative refactors** and **no renaming variables the human author didn't touch** — especially from bot/AI-assisted PRs. AGENTS.md is explicit: reviewer time is scarce, don't spend it on noise.
- **Update docs in the same PR** when behaviour or the CLI surface changes. The README file-layout tree, the MCP tool list, and `crates/harness-data/src/lib.rs` are the places most likely to drift.
- **Test plan checklist** at the end of every PR body. PRs without one get sent back.
- AI-assisted changes keep the `Co-Authored-By:` footer. Honest provenance signal.
- Branch names are free-form; recent style is `feat/<short-slug>` or `feat/t-###-<slug>`.
- Commit titles: short imperative, optionally scoped (`gui:`, `T-104:`, `rly rebuild:`). Body explains the *why*. No Conventional Commits, no emoji, no ticket-reference footers beyond the internal `T-###` shorthand.

## Cross-Dashboard Contract (the hidden convention)

If you change a TS shape under `src/domain/`, you MUST also:
1. Update `crates/harness-data/src/lib.rs` in the **same PR** (TUI + GUI Rust deserializers).
2. If you added an MCP tool, update the README MCP list. (`rly inspect-mcp` is the live source of truth, but people grep the README count.)
3. If you changed the `~/.relay/` file layout, update the README file-layout tree and `docs/getting-started.md`.

This is the single most common silent-breakage class in the repo. Treat it as a hard convention.

---

*Convention analysis: 2026-05-09*
