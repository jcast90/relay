# External Integrations

**Analysis Date:** 2026-05-09

Relay is local-first: there is no Relay-hosted API, no telemetry endpoint, no auth provider, and no SaaS dependency. External integrations are limited to (1) the AI provider CLIs the orchestrator dispatches, (2) issue trackers / SCMs, and (3) the JSON-RPC MCP surface Relay exposes for callers. State is persisted to `~/.relay/` and is the source of truth for every dashboard.

## AI Providers

The orchestrator does not call AI HTTP APIs directly. It dispatches to the user's locally-installed Claude / Codex CLIs and reads their structured output. Token-usage telemetry today rides on the `stream-json` events emitted by Claude (the `result` event has the final answer; per-line `assistant`/`tool_use` events drive the tool-activity feed). There is no consolidated usage counter yet.

**Anthropic Claude — `ClaudeCliAgent` (`src/agents/cli-agents.ts`):**
- **Adapter:** `class ClaudeCliAgent extends CliAgentBase` — registered by `createLiveAgents` in `src/agents/factory.ts` for any spec whose resolved provider is `"claude"`. The default provider is `"claude"` (`AgentFactoryOptions.defaultProvider`).
- **Transport:** spawns the local `claude` binary via `CommandInvoker.exec` (buffered) or `CommandInvoker.spawn` (streaming). Buffered call uses `claude -p --output-format json --json-schema <agentResultJsonSchema>`. Streaming call uses `--output-format stream-json --verbose`.
- **Schema injection:** `agentResultJsonSchema` (derived from `AgentResultSchema` in `src/domain/agent.ts`) is JSON-stringified and passed as `--json-schema`, forcing Claude to return a structured response that the adapter then re-validates with Zod (`normalizePayload`).
- **Auth:** Relay never reads the API key. The `passEnv: [...CLAUDE_PASS_ENV, ...this.extraPassEnv]` opt-in in `cli-agents.ts:404` allows the spawned subprocess to read `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME`, plus AWS / GCP creds for Bedrock / Vertex routing (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`).
- **Permission mode:** `--dangerously-skip-permissions` is passed when `RELAY_AUTO_APPROVE` is set OR the channel has `fullAccess: true` (AL-0). Otherwise `--permission-mode default` is passed and the user is prompted in-CLI.
- **Role lockdown (AL-11):** when a restricted role is set on the channel, `appendDisallowedBuiltinArgs` (same file) appends `--disallowed-tools Edit,Write,NotebookEdit,Bash` (or whatever `getDisallowedBuiltinsForRole` returns) and sets `RELAY_AGENT_ROLE=<role>` in the subprocess env so the MCP server's per-role allowlist (`src/mcp/role-allowlist.ts`) gates MCP-routed tools.
- **Streaming response surface:** `invokeStreaming` (`src/agents/cli-agents.ts:425`) parses each `stream-json` line, drives `onStreamLine(line)` for the CLI activity renderer (`src/cli/stream-activity-renderer.ts`), and accumulates `type: "assistant"` text blocks until a `type: "result"` line appears. The TUI worker in `tui/src/main.rs` and the GUI backend in `gui/src-tauri/src/lib.rs` parse the same event stream; the shared one-liner formatter lives in `crates/harness-data/src/tool_activity.rs` (mirror of `src/domain/tool-activity.ts`).
- **Where Claude responses surface:** orchestrator `WorkRequest.run()` returns the parsed `AgentResult` to the planner / decomposer / scheduler in `src/orchestrator/`; raw stdout is preserved as `rawResponse`. Tool-use activity is surfaced live to the CLI (`createStreamActivityRenderer`), TUI (`tui/src/ui.rs`), and GUI (`gui/src-tauri/src/lib.rs` emits Tauri events).

**OpenAI Codex — `CodexCliAgent` (`src/agents/cli-agents.ts`):**
- **Adapter:** `class CodexCliAgent extends CliAgentBase` — selected when `provider === "codex"` in `createLiveAgents`.
- **Transport:** spawns `codex exec -C <cwd> --skip-git-repo-check --sandbox <mode> --output-schema <schema> -o <out>`. Codex writes its structured response to a temp file (`response.json`); the adapter reads it back, validates against the same Zod `AgentResultSchema`, and cleans up the temp dir.
- **Sandbox mode:** `read-only` by default; flips to `workspace-write` plus `--ask-for-approval never` when `RELAY_AUTO_APPROVE` or `fullAccess` is set.
- **Auth:** `passEnv: [...CODEX_PASS_ENV, ...this.extraPassEnv]` forwards `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`, `AZURE_OPENAI_*`, and `CODEX_HOME` to the spawned codex.
- **Role lockdown (AL-11):** Codex has no `--disallowed-tools` equivalent today; the adapter logs a deferred-enforcement notice to stderr (`cli-agents.ts:307`) but still propagates `RELAY_AGENT_ROLE` so MCP-routed tools are gated.
- **Streaming:** Codex does not have a stream-json equivalent in this adapter; `onStreamLine` is silently ignored for Codex (factory only wires the hook for `provider === "claude"`, see `src/agents/factory.ts:122`).

**Provider-profile env overlay (`src/domain/provider-profile.ts`, `src/storage/provider-profile-store.ts`):**
- Channels can be bound to a named provider profile (`adapter: "claude" | "codex"`, `envOverrides: Record<string,string>`, optional `apiKeyEnvRef: string`, optional `defaultModel`). The profile's overrides are applied per-spawn via `roleEnvOverlay()` in `cli-agents.ts:222`, which means a channel can ship `OPENAI_BASE_URL=https://openrouter.ai/api/v1` without mutating the operator's global env.
- **Secrets are not stored in profiles.** `validateEnvOverrides` rejects values that look like raw keys (`isLikelySecretValue`); the user supplies a secret indirectly by setting `apiKeyEnvRef: "OPENROUTER_API_KEY"` on the profile and exporting `OPENROUTER_API_KEY` in their shell. Relay forwards the *name* via `extraPassEnv` and never dereferences the value.
- Persisted at `~/.relay/provider-profiles/*.json` (file backend).

## Issue Trackers

**GitHub Issues — `src/integrations/tracker.ts`:**
- **Adapter:** `createTracker("github")` wraps `@aoagents/ao-plugin-tracker-github`'s `create()` factory.
- **Auth:** the AO plugin reads `GITHUB_TOKEN` from `process.env` at construction time. When a caller passes `{ token }`, the harness installs it via `withEnvOverride` from `src/integrations/plugin-env-mutex.ts` (a serializing mutex; see `AGENTS.md`'s warning that this is **not reentrant**). Onboarding nudges the user to create a token at `https://github.com/settings/tokens` (`src/cli/welcome.ts:189`).
- **Surface:** `resolveIssue(tracker, identifier, project)` projects the AO issue into a narrow `HarnessIssue` ({ id, title, body, url, labels, branchName }). Detection helpers in the same file: `detectTrackerKind` matches `https://github.com/<owner>/<repo>/issues/<n>`.
- **Boundary rule:** `import` from `@aoagents/*` is allowed **only** in `src/integrations/tracker.ts` and `src/integrations/scm.ts`; nothing else in the codebase should pierce that wall (per the file-header comments).

**Linear — `src/integrations/tracker.ts` + `src/integrations/linear-mirror.ts`:**
- **Adapter (issue resolution):** `createTracker("linear")` wraps `@aoagents/ao-plugin-tracker-linear`. Same env-mutex pattern, env var `LINEAR_API_KEY`. Detection covers `https://linear.app/<workspace>/issue/<ID>` and bare `ABC-123` identifiers.
- **Direct GraphQL (project mirror):** `src/integrations/linear-mirror.ts` talks to Linear directly because the AO plugin's `listIssues` filters by team rather than by project. Endpoint is hard-coded:
  - `LINEAR_API_URL = "https://api.linear.app/graphql"` (`linear-mirror.ts:19`)
  - POSTs GraphQL with `Authorization: <LINEAR_API_KEY>` (no `Bearer` prefix, per Linear).
  - `fetchLinearProject` / `mirrorLinearProject` project Linear issues onto the channel's ticket board with `source: "linear"` and `linear:<id>` ticket IDs. The orchestrator scheduler **never executes Linear-mirrored tickets** — they are read-only on-board markers.
- **Auth scope:** personal API key (starts with `lin_api_`); user is pointed at `https://linear.app/settings/api` (`src/cli/welcome.ts:196`).

**GitHub Projects v2 — `src/integrations/github-projects/`:**
- Contents: `client.ts`, `draft-items.ts`, `fields.ts`, `sync-worker.ts`, `channel-hooks.ts`, `url-parser.ts`.
- **Endpoint:** `GITHUB_API_URL = "https://api.github.com/graphql"` (`client.ts:15`), POSTed with `Authorization: bearer <token>`.
- **Direction:** one-way, Relay-authoritative. The sync worker (`sync-worker.ts::syncTick`) projects Relay tickets onto a channel-linked GitHub project epic and overwrites detected drift on each tick.
- **Token scope:** `project` (and `read:org` for org-owned projects), per the `ProjectsClientDeps` doc-comment (`client.ts:34`). The token never reads from `process.env.GITHUB_TOKEN` directly here — callers inject it explicitly so the secret-handling contract stays uniform with the rest of the codebase.
- **Rate-limit awareness:** `githubProjectsGraphqlWithMeta` returns `RateLimitInfo`; `syncTick` returns `throttled: true` and exits early when remaining budget drops below `minRateLimitBudget` (default 200).

## Source Control Manager

**GitHub SCM — `src/integrations/scm.ts`:**
- **Adapter:** `createScm("github")` wraps `@aoagents/ao-plugin-scm-github`'s `create()`. Token plumbing is identical to the tracker (no overlay needed when `GITHUB_TOKEN` is already exported, since the plugin shells out to `gh` lazily; explicit token routes through `withEnvOverride`).
- **Surface (`HarnessScm` in `scm.ts`):** `detectPR(branch, repo)`, `getCiSummary(pr)`, `getReviewDecision(pr)`, `getPendingComments(pr)`, `enrichBatch(prs)`. The narrow facade keeps AO types out of the rest of the codebase.
- **Underlying tool:** `gh` CLI. Required for all GitHub PR operations. The PR reviewer (see below) explicitly forwards `GH_TOKEN`/`GITHUB_TOKEN` to its `gh` invocations.

**PR Poller — `src/integrations/pr-poller.ts`:**
- Consumes `HarnessScm` to watch tracked PRs. Transitions: ci → "failing" enqueues a `fix-ci` follow-up; review → "changes_requested" enqueues `address-reviews`; merged/closed untracks. Uses `FollowUpDispatcher` (`src/integrations/scheduler-follow-up-dispatcher.ts`) because `TicketScheduler` does not expose a public enqueue surface.
- Snapshots are mirrored to `~/.relay/.../tracked-prs.json` for the TUI/GUI.

**PR Reviewer — `src/integrations/pr-reviewer.ts`:**
- Spawns a Claude/Codex subprocess to read a fetched PR (`gh pr checkout <number>`) and produce review findings.
- Explicit `passEnv: ["GH_TOKEN", "GITHUB_TOKEN"]` (`pr-reviewer.ts:280, 288`) — the only place outside the adapters that opts secrets back into a child env.

## Data Storage

**Local filesystem (`~/.relay/`) — primary:**
- All persistent state lives under `~/.relay/`. Layout managed by `src/cli/paths.ts::getRelayDir` (overridable via `RELAY_HOME`).
- Atomic writes (tmp-file + rename) are required for any new persistence; pattern in `src/storage/file-store.ts` and `src/channels/channel-store.ts`.
- `feed.jsonl` is **append-only**; corrections are posted as new entries, never edits in place (per `AGENTS.md`).
- The shared Rust crate `crates/harness-data/src/lib.rs` defines deserialization-only structs that mirror what the TS writers emit (`WorkspaceRegistry`, `RunsIndex`, `TicketLedger`, channel shapes, …) using `#[serde(rename_all = "camelCase")]`. **TS shape change → Rust struct change in the same PR.**

**Postgres — placeholder, off by default:**
- `src/storage/postgres-store.ts` (`PostgresHarnessStore`) implements the full `HarnessStore` contract over `pg.Pool`, with `LISTEN/NOTIFY` for cross-process coordination and a schema in `src/storage/migrations/001_init.sql` (tables `harness_docs`, `harness_logs`, `harness_blobs`).
- `src/storage/factory.ts::buildHarnessStore` ignores `HARNESS_STORE=postgres` today: it logs a one-line warning and returns `FileHarnessStore`. The Postgres code is retained against the roadmap.
- Connection: `pg.Pool` constructed by the caller (or from a connection string); the integration CI workflow (`.github/workflows/integration.yml`) is the only path that exercises this.

**SQLite:** declared as a future `StoreKind` in `src/storage/factory.ts:5` but no implementation exists.

**File Storage (blobs):** `HarnessStore.putBlob` / `getBlob` (`src/storage/store.ts`); the file backend writes `${ns}/${id}.blob` plus an optional `${ns}/${id}.blob.meta.json` sidecar. Used for command stdout/stderr captures, design-doc artifacts, and uploads. No S3 / cloud blob storage.

**Caching:** none. Disk is authoritative; the `HarnessStore` watch surface (file-poll for the file backend, `LISTEN/NOTIFY` for Postgres) propagates updates.

## MCP Surface (Relay as a server)

Relay exposes its own JSON-RPC MCP tool surface to dispatched Claude / Codex sessions and to remote clients.

**In-process MCP server:**
- Entry: `src/mcp/server.ts::buildMcpMessageHandler` and `startMcpServer`. Tool sets are composed from:
  - `src/mcp/channel-tools.ts` — channel feed / tickets / decisions.
  - `src/crosslink/tools.ts` — cross-session messaging.
  - `src/mcp/coordination-tools.ts` (AL-16) — `coordination_send`.
  - `src/mcp/pr-review-tool.ts` — kicks off `startPrReviewDm`.
  - `src/agents/repo-admin.ts::REPO_ADMIN_TOOL_STUBS` — the AL-11 / AL-12 repo-admin role surface.
- Authoritative tool list: `rly inspect-mcp` (and the README's MCP tool count, which people grep — see `AGENTS.md`).

**HTTP/SSE transport:**
- `src/mcp/http-transport.ts::startHttpMcpServer` mirrors the upstream `@modelcontextprotocol/sdk` SSE protocol without depending on the SDK package.
- Bind: `RELAY_PORT` (default `7420`), `RELAY_TOKEN` for bearer-auth.
- **Hard-stop:** `rly serve` refuses to start on a non-loopback host without a token unless `--allow-unauthenticated-remote` is passed. Rules live in the pure function `src/mcp/serve-validation.ts::validateServeOptions`.
- Body limit enforced; `BodyTooLargeError` maps to HTTP 413.

**MCP roles & allowlist:**
- `src/mcp/role-allowlist.ts` — the per-role tool gate. `RELAY_AGENT_ROLE` env var on the spawned session selects the role; only `repo-admin` is configured today. The allowlist also reports which built-in tools must be denied at the CLI level (Edit/Write/NotebookEdit/Bash) since those don't round-trip through MCP.

## Authentication & Identity

**No central auth provider.** Relay is local-first and unauthenticated by default.

- **`rly serve` HTTP MCP:** bearer-token auth via `--token` / `RELAY_TOKEN`, validated with `timingSafeEqual` (`src/mcp/http-transport.ts`). Loopback + no token only warns (default dev workflow). Non-loopback + no token is a hard error.
- **External services** (GitHub, Linear, Anthropic, OpenAI) authenticate via their own user-supplied env vars. Tokens are never persisted in `~/.relay/`; the welcome flow writes them to `~/.relay/config.env` (mode 0600) only on user opt-in.

## Monitoring & Observability

- **Error tracking:** none. Errors print to stderr; the orchestrator surfaces failures into the channel feed as entries.
- **Logs:** local only. Per-channel append-only `feed.jsonl`. `src/channels/channel-store.ts::postEntry` is the single write path.
- **Telemetry:** no outbound metrics. Token-usage telemetry is the next on-deck work; today the only signal is the `stream-json` `result` event from Claude (`src/agents/cli-agents.ts:483`), which the adapter consumes for the final response text but does not yet record usage counters from.

## CI/CD & Deployment

**Hosting:**
- Distributed as the npm package `@jcast90/relay` (`package.json` `bin: { "rly": "bin/rly.mjs" }`). No SaaS counterpart.
- The Tauri GUI bundles into a desktop `.app`/installer locally via `pnpm gui:build`.

**CI Pipeline (`.github/workflows/`):**
- `ci.yml` — fast scripted tier on every PR (vitest, typecheck, build, format-check, `cargo check --workspace` when Rust changes).
- `integration.yml` — integration tier (Postgres / real-git / live-GitHub) nightly or on-demand.
- `release.yml` — npm publish via Changesets.
- `changesets.yml` — version PR automation.

## Webhooks & Callbacks

**Incoming:** none. Relay does not expose webhook endpoints. The only inbound HTTP surface is the optional `rly serve` MCP transport.

**Outgoing:** none. Relay never POSTs to user infra. Every external request is GraphQL/REST to a tracker / SCM endpoint, initiated from the user's machine.

## Cross-process / IPC Boundaries

**TypeScript ↔ Rust (TUI + GUI) — shared `~/.relay/`:**
- The orchestrator writes `~/.relay/`; the TUI and GUI read it. There is no socket, no RPC, no shared memory between them.
- `crates/harness-data/src/lib.rs` is the schema contract. Mirrors include `WorkspaceRegistry`, `RunsIndex`, `TicketLedgerEntry`, channel and feed entries, tool-activity entries (`crates/harness-data/src/tool_activity.rs`).
- The TUI binary uses `harness-data` as a path dep (`tui/Cargo.toml:14`); the GUI backend uses it identically (`gui/src-tauri/Cargo.toml:21`).
- The TUI also re-invokes `rly` for actions that mutate state — `cli_bin()` / `cli_json(args)` in `tui/src/main.rs:26-46` shell out to the CLI (configurable via `RELAY_BIN`).

**Tauri IPC (GUI):**
- `gui/src/api.ts` calls `invoke()` from `@tauri-apps/api/core` for every action; the Rust backend in `gui/src-tauri/src/lib.rs` registers ~50 `#[tauri::command]` handlers (registered in the `invoke_handler!` macro at `lib.rs:4049`). Examples: `list_workspaces`, `list_channels`, `start_chat`, `spawn_agent`, `list_pending_approvals`.
- Tauri events (via `tauri::Emitter`) push streaming chat / activity updates from Rust to the React renderer. Listeners use `@tauri-apps/api/event::listen`.

**Crosslink / agent-to-agent:**
- `src/crosslink/coordinator.ts` is the in-process bus; cross-process delivery uses the JSONL inbox/outbox files in `~/.relay/` plus `src/crosslink/ipc-bridge.ts` to tail and replay messages into the live coordinator. The MCP server falls back to a `coordinator-not-configured` error envelope when the in-process coordinator isn't wired (e.g. when the MCP server runs as a subprocess of the Claude CLI).

## Environment Configuration Summary

**Required for live runs:**
- A working `claude` CLI (the user's own Anthropic auth) — or `codex` CLI if `HARNESS_PROVIDER=codex` / a channel uses a codex profile.
- `gh` CLI for any GitHub PR / SCM path.
- `GITHUB_TOKEN` for tracker + GH Projects + PR poller paths.
- `LINEAR_API_KEY` for Linear ingest + mirror.

**Secrets location:**
- `~/.relay/config.env` (chmod 0600) when scaffolded by `rly welcome`.
- Otherwise the user's shell profile (`.zshrc`, `.bashrc`, etc.) — Relay never reads or stores secrets in `~/.relay/` JSON.

---

*Integration audit: 2026-05-09*
