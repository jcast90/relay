# Codebase Concerns

**Analysis Date:** 2026-05-09

Relay is pre-v1 by design — the README and `SECURITY.md` document several "Known limits" and "Known-and-accepted risks" that are deliberate trade-offs, not bugs. The list below separates those acknowledged trade-offs from genuine fragility, and pays special attention to surfaces that the upcoming token-telemetry phase (Phase 1, ROADMAP) and handoff-brief synthesis phase (Phase 2) will touch directly.

When a finding is observable but unconfirmed, it is tagged **(verify)** rather than asserted as a bug.

## Tech Debt

### Provider adapters do not extract token usage from CLI output (high)

- Issue: The Claude streaming path (`src/agents/cli-agents.ts:425-520`, `invokeStreaming`) parses `assistant` blocks for text and `result` blocks for the final string but **never reads the `usage`/`message.usage` field that Claude's `--output-format stream-json --verbose` emits per assistant turn**. The buffered Claude path (`src/agents/cli-agents.ts:347-416`) and the Codex path (`src/agents/cli-agents.ts:258-345`) likewise discard everything except the schema-shaped result body.
- Files: `src/agents/cli-agents.ts:413` (Claude buffered: `rawResponse: result.stdout` then `JSON.parse` — usage discarded), `src/agents/cli-agents.ts:483-485` (`obj.type === "result"` only captures `obj.result`), `src/agents/cli-agents.ts:332` (Codex reads `outputPath` only — schema-shaped JSON, no usage).
- Impact: `TokenTracker` (`src/budget/token-tracker.ts`) is fully implemented (replay-on-construct, threshold events at 50/60/85/95/100, `record()` API at `:120`) and a `RepoAdminSession` owns one (`src/orchestrator/repo-admin-session.ts:408,448-459`) — but a project-wide `grep` for `tracker.record(` / `tokenTracker.record(` / `input_tokens` / `output_tokens` returns zero call sites. The wiring to feed real numbers from the adapter to the tracker does not exist. README "Known limits" explicitly states "Cost guardrails not yet implemented. Token usage isn't tracked or capped." This is the primary blocker for the upcoming context-window-bar phase.
- Fix approach: extend `ParsedProviderResult` (`src/agents/cli-agents.ts:84-94`) with a `usage?: { inputTokens; outputTokens; cacheRead?; cacheWrite? }` field; in `invokeStreaming` accumulate `obj.message.usage` from `assistant` events and read final totals from the `result` event; in the buffered Claude path parse `result.stdout` for the same `usage` object Claude emits in `--output-format json`; in Codex parse the `tokenUsage` block Codex includes in its schema-output JSON. Then thread the result up to `RepoAdminSession.run()` so the existing tracker fires.

### Channel state has no schema-version field anywhere (high)

- Issue: `~/.relay/channels/<id>.json`, `feed.jsonl`, `tickets.json`, `decisions/<id>.json`, and `runs.json` are written and read on both sides (TS via `src/channels/channel-store.ts`, Rust via `crates/harness-data/src/lib.rs`) without a `schemaVersion` field. The only versioned artifact in the entire repo is the install manifest (`src/install/manifest.ts:22`, `schemaVersion: 1`).
- Files: `src/domain/channel.ts` (Channel type — no version), `src/channels/channel-store.ts:136-149` (channel write — no version emitted), `crates/harness-data/src/lib.rs:870-955` (`load_channels`, `load_channel` — accepts whatever it can deserialize).
- Impact: Any future shape change to `Channel`, `ChannelEntry`, `TicketLedgerEntry`, or `Decision` is a one-way migration with no detection, no fallback, and no defined upgrade path. AGENTS.md already calls this out as the "it compiled but the TUI shows nothing" class of bug (`AGENTS.md:105`). For Phase 2 (handoff brief synthesis), brief artifacts that may live on disk for "a week" cannot be safely evolved without a versioning story.
- Fix approach: add an optional `schemaVersion?: number` to each persisted root type, default to `1` for unversioned files, and gate any future shape change on a forward migration step. The `src/storage/migrations/` runner (`src/storage/migrations/runner.ts`) only handles the Postgres backend today; a parallel "JSON-on-disk migration" surface would need to be introduced.

### Postgres `HarnessStore` is stubbed but unwired (medium, acknowledged)

- Issue: `src/storage/postgres-store.ts` (497 lines) is a complete-looking implementation with `LISTEN/NOTIFY` watch, `SELECT … FOR UPDATE` mutate, and migration runner — but `src/storage/factory.ts` warns and falls back to file when `HARNESS_STORE=postgres` (README "Storage & execution backends" section confirms). Several `*.integration.test.ts` files for Postgres are in `describe.skip` blocks (`test/storage/postgres-store.integration.test.ts`, `test/storage/postgres-migrations.integration.test.ts`).
- Impact: Cross-process correctness for `upsertChannelTickets`, `recordDecision`, and `register_workspace` is **process-local only**. Comment at `src/channels/channel-store.ts:34-35` is explicit: "In-process only; cross-process coordination for multi-writer deployments (multiple schedulers) comes with the Postgres-backed HarnessStore in T-402." `crates/harness-data/src/lib.rs:797-804` documents the same race for the workspace registry: "two concurrent registers (one CLI, one GUI) race on read-modify-write — last writer wins, possibly dropping one append."
- Severity: medium — the Roadmap acknowledges this and the practical risk is bounded (registers happen at attach time, not in tight loops; ticket upserts within one orchestrator are serialized correctly).
- Fix approach: tracked by issue #155 ("Wire the Postgres backend end-to-end") and the README Roadmap's first bullet.

### Two file-watch strategies on the same directory tree (medium)

- Issue: TS `FileHarnessStore.watch` (`src/storage/file-store.ts:288-310`) polls mtimes every **250 ms**. Rust readers (`crates/harness-data/src/lib.rs`) re-read on demand without a watcher abstraction at all — the TUI and GUI re-poll from the React/ratatui render loop. There is no shared change-event bus; each surface re-reads the whole file on each tick.
- Files: `src/storage/file-store.ts:288-310` (TS poll loop, 250 ms), `crates/harness-data/src/lib.rs:870-1025` (Rust on-demand reads).
- Impact: For large feeds (`feed.jsonl` is append-only, no rotation — see "fragile areas" below) the Rust readers do a full file read on every refresh. The TS watcher's 250 ms poll is fine for human-scale activity but coalesces rapid-fire writes (e.g. tool-use streaming) which could matter for the upcoming token-telemetry per-turn updates. (verify) — measure feed.jsonl read cost on a multi-hour autonomous channel before the telemetry phase locks in a similar polling pattern.
- Fix approach: when token-usage snapshots ship, persist them to a small per-session `usage.json` doc rather than tail-appending to `feed.jsonl`, so dashboards re-read a small file rather than re-parsing the entire feed.

### `index.ts` is a 3,485-line CLI dispatcher (medium)

- Issue: `src/index.ts` is the single dispatch table for every `rly` subcommand. Adding a new command means landing in this one file. AGENTS.md doesn't call this out, but it surfaces in PR diffs as constant churn on a hot file.
- Files: `src/index.ts` (3,485 lines).
- Impact: Merge conflicts on parallel feature branches; hard to reason about subcommand isolation; no single place that lists "what commands does `rly` expose" without reading the whole file.
- Fix approach: extract per-subcommand modules into `src/cli/<subcommand>.ts` (a few already live there — `cli/run-autonomous.ts`, `cli/session-store.ts`) and reduce `index.ts` to a registration table.

### `gui/src-tauri/src/lib.rs` is 4,122 lines with 115+ functions (medium)

- Issue: Single monolithic file owns: terminal-spawn detection (macOS `osascript`, Linux 7-binary probe chain, Windows `wt`/`powershell`/`cmd` fallback), shim resolution for Finder-launched apps, channel/feed/ticket/decision read paths, spawn tracking, and the Tauri command surface.
- Files: `gui/src-tauri/src/lib.rs` (4,122 lines, 115 fn definitions).
- Impact: Every GUI Tauri command lands in the same file. AGENTS.md (`AGENTS.md:121`) explicitly warns: "Any new `Command::new(...)` in `lib.rs` that targets a binary the user might have installed under their home dir or a homebrew prefix must also `.env("PATH", augmented_child_path())`, or it will ENOENT under Finder launches while working fine from a terminal." This is exactly the kind of cross-cutting concern that gets missed when a file is too big to scan.
- Fix approach: split into `lib.rs` (registration only), `spawn.rs` (terminal launching + tracking), `loaders.rs` (channel/feed/ticket reads — most of which could route through `harness-data` instead of duplicating).

### Cross-language read-during-write race on `feed.jsonl` (medium, verify)

- Issue: TS `channel-store.postEntry` uses raw `appendFile` on `feed.jsonl` (`src/channels/channel-store.ts:622`) — no atomic temp-rename, by design (the file is append-only). Rust readers in `crates/harness-data/src/lib.rs:999-1018` `load_channel_feed` `read_to_string` the whole file then split on newlines.
- Files: `src/channels/channel-store.ts:622` (TS append-no-fsync), `crates/harness-data/src/lib.rs:1005-1015` (Rust full-file read + line-split).
- Impact: If a TS writer is mid-`appendFile` and a Rust reader runs `read_to_string` concurrently, the Rust side may observe a partial trailing line. The Rust loader filters via `serde_json::from_str` on each line; a partial line will silently fail to parse and be dropped (`crates/harness-data/src/lib.rs:1011-1015` — line is silently skipped on parse failure). Symptom: a freshly posted feed entry occasionally not visible in the TUI/GUI for one render cycle, then visible on the next read once the write completes. (verify) — no reproduction exists; comment at `crates/harness-data/src/lib.rs:1011` says "skip malformed lines" without specifically noting partial-write tolerance, but the test `session-store-harness-store.test.ts:217-240` confirms the policy is "warn + skip" for malformed JSONL.
- Fix approach: low priority — append + read-once already self-heals on the next render. If it surfaces as a UX issue, the Rust side could fall back to ignoring the trailing line when it fails to parse AND it's the very last line of a non-empty buffer (only that line is potentially torn).

### Console logging via `eslint-disable-next-line no-console` proliferating (low)

- Issue: 30+ files in `src/` carry `// eslint-disable-next-line no-console` comments to bypass the lint rule. Concentrated in: `src/orchestrator/ticket-runner.ts` (12 sites), `src/mcp/http-transport.ts` (8), `src/orchestrator/repo-admin-pool.ts` (4), `src/orchestrator/worker-spawner.ts` (3).
- Files: see grep above.
- Impact: There's no structured logger — every "log this" decision is a one-off `console.warn` or `console.error` exempted from the lint rule. Open issue #179 ("Observability: structured logging + crash reporting") tracks this.
- Fix approach: introduce a thin logger module (or pull in `pino`) and migrate sites by directory.

## Known Bugs

(No "open and labeled bug" issues exist on the GitHub project — `gh issue list --label bug` is empty as of 2026-05-09. The issues below are observed-but-uncategorized.)

### `channel-store.touchChannel` race on tmp filename when bursts collide (low, mitigated)

- Symptoms: Stderr noise — "channel post failed" — even when the post itself semantically succeeded. Documented at `src/channels/channel-store.ts:48-55`.
- Files: `src/channels/channel-store.ts:526-531` (`touchChannel` body), `:55` (mitigation counter `channelManifestTmpCounter`).
- Trigger: Two concurrent `postEntry` → `touchChannel` cycles in the same process tick (e.g. orchestrator transition + agent dispatch).
- Workaround: Already in place — per-call `channelManifestTmpCounter++` ensures unique tmp paths. Verify the same pattern is applied to all other tmp-file writers in `src/channels/channel-store.ts` and `crates/harness-data/src/lib.rs:840-865`.

### `RELAY_USE_DIST=1` masks live-source edits silently (low, documented)

- Symptoms: Edits to `src/` don't take effect; user is confused.
- Files: `bin/rly.mjs`, README "How `rly` finds the source" section.
- Trigger: User exports `RELAY_USE_DIST=1`, edits `src/`, expects changes.
- Workaround: Documented behaviour. `rly rebuild` refreshes `dist/`. Could be louder — print "running from dist (RELAY_USE_DIST set)" on `rly --version` or first command.

## Security Considerations

### `RELAY_AUTO_APPROVE=1` is documented as the user's footgun (informational, accepted)

- Risk: Drops every Claude/Codex permission prompt for the entire session. `rm -rf`, `git push --force`, unlinked network calls all execute without confirmation.
- Files: `src/agents/cli-agents.ts:270-274,353-357` (where the flag is read), `SECURITY.md` "Known-and-accepted risks".
- Current mitigation: Documented as a footgun in three places (README "Unattended mode", `SECURITY.md`, `cli-agents.ts` comments). Per-channel `fullAccess` flag (AL-0) gives a more scoped opt-in.
- Recommendations: None — accepted by design. Phase 1's threshold events could optionally tie into Phase 2's handoff to reduce time spent in this mode.

### Subprocess env sanitizer relies on a regex (medium)

- Risk: A new credential-shaped env var name pattern that doesn't match `SECRET_NAME_PATTERN` (`src/agents/command-invoker.ts:72-73`) would leak through into spawned children. The regex covers common forms (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, `*BEARER*`, `*JWT*`, `*OAUTH*`, `*CRED*`) but is necessarily incomplete.
- Files: `src/agents/command-invoker.ts:72-73` (regex), `:107-144` (sanitizer logic).
- Current mitigation: Two-pass — explicit allowlist + regex-strip. Tests in `test/command-invoker.test.ts` exercise both. Default whitelist is conservative (`PATH`, `HOME`, etc. plus `LC_*`, `HARNESS_*`, `RELAY_*` prefixes).
- Recommendations: when the cost-tier feature ships per-channel provider profiles (issues #200-#203), each new pass-env name should be reviewed against the regex. Consider adding an explicit blocklist for known third-party patterns the regex misses (e.g. `DATABASE_URL` is not credential-shaped but contains a password).

### Tokens stored in `~/.relay/config.env` with default Unix perms (informational, accepted)

- Risk: Anyone with read access to the user's home dir can read `GITHUB_TOKEN`, `LINEAR_API_KEY`, `COMPOSIO_API_KEY`.
- Files: `~/.relay/config.env` (user-managed), `SECURITY.md` "Known-and-accepted risks".
- Current mitigation: Documented. Standard Unix perms.
- Recommendations: None — accepted.

### `rly serve` non-loopback bind requires `--token` or explicit override (low, well-handled)

- Risk: The MCP HTTP server, when bound to a non-loopback interface, would expose the harness to LAN/internet. Validation in `src/mcp/serve-validation.ts` is documented as pure + unit-tested.
- Mitigation: Hard-stop on non-loopback + no token; loopback + no token only warns. Escape hatch (`--allow-unauthenticated-remote`) exists for genuine remote-access setups.

## Performance Bottlenecks

### `feed.jsonl` re-read on every TUI/GUI render cycle (medium, verify)

- Problem: `crates/harness-data/src/lib.rs:1005-1018` (`load_channel_feed`) does `fs::read_to_string` on the whole file then splits on newlines. There is no rotation, no offset cursor, no tail-only path. A long-running autonomous channel's feed grows indefinitely.
- Files: `crates/harness-data/src/lib.rs:1005-1018`, no corresponding rotation logic in `src/channels/channel-store.ts`.
- Cause: Append-only design (`AGENTS.md:111-113` — "feed is append-only — never rewrite it") means a feed file size is unbounded.
- Improvement path: at the Rust loader, accept a `since_offset` parameter and seek to a stored offset; cache the parsed entries with an mtime check; or expose only the tail N entries (which `load_channel_feed` already supports via `limit: usize`, but it still reads the whole file first). (verify) — measure on a multi-hour autonomous run before optimizing.

### TS `watch` polls every 250 ms across all watched docs (low)

- Problem: `src/storage/file-store.ts:291` (`pollIntervalMs = 250`). Each watcher costs one stat call per polled path per tick. With many channels and many simultaneously-mounted watches, this scales linearly.
- Cause: `fs.watch` was deliberately rejected (`src/storage/file-store.ts:278-281`) due to platform quirks.
- Improvement path: shared poll loop across all watchers in a single store, or a coalesced 1 Hz poll for low-frequency surfaces. Acceptable today; revisit if dashboard CPU becomes an issue.

## Fragile Areas

### Cross-dashboard contract: `src/domain/` ↔ `crates/harness-data/src/lib.rs` (high)

- Files: `src/domain/*.ts`, `crates/harness-data/src/lib.rs:1-2438`.
- Why fragile: AGENTS.md explicitly calls this out (`AGENTS.md:105`): "Change a shape in `src/domain/` → update `crates/harness-data/src/lib.rs` in the same PR. The TUI and GUI deserialize JSON via serde against those Rust structs; if a new required field appears and the Rust side doesn't know about it, the dashboards silently drop rows or fail to parse." The Rust types use `#[serde(default)]` for some fields but not all, and the failure mode (silent drop) is hard to detect in code review.
- Safe modification: Always update both sides in the same PR. Run `cargo check --workspace` AND `cargo test --workspace` before pushing — the Rust integration tests deserialize fixture JSON that mirrors the on-disk shape and will fail loudly on schema drift.
- Test coverage: tests exist (`crates/harness-data/src/lib.rs:2311-2438` — fixture-driven), but they test what's deserialized, not what's missed. A new optional field in `src/domain/channel.ts` that the Rust struct ignores is silently dropped from the GUI without any test failure. Adding `#[serde(deny_unknown_fields)]` would surface drift but break forward-compat for older Rust binaries reading newer JSON. There's no clean answer.

### Postgres backend stubbed but `factory.ts` falls back without surfacing in CI (medium)

- Files: `src/storage/factory.ts`, `src/storage/postgres-store.ts`.
- Why fragile: A user setting `HARNESS_STORE=postgres` gets a fallback warning and silently runs against the file backend. No CI smoke test asserts the fallback behaviour, and the in-tree integration tests are `describe.skip`.
- Safe modification: Don't add `HARNESS_STORE` branches without unskipping at least one Postgres integration test in the nightly tier (`.github/workflows/integration.yml`).
- Test coverage: gap — see "Test Coverage Gaps" below.

### Spawn paths off macOS are compile-checked, not device-tested (high, acknowledged)

- Files: `gui/src-tauri/src/lib.rs:2668-2754` (Linux), `:2716-2755` (Windows).
- Why fragile: AGENTS.md states this directly (`AGENTS.md:121`): "The Linux/Windows paths are compile-checked via `cargo check --workspace` but only smoke-tested in CI — real-device testing on those platforms is the integration gate before release." README "Known limits" first bullet repeats it.
- Safe modification: Touching `spawn_agent_linux` / `spawn_agent_windows` is a real-hardware-test change. The 7-binary terminal-emulator probe chain on Linux (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`, `alacritty`, `kitty`, `wezterm`) is brittle to terminal-emulator quirks (e.g. `wezterm`'s child-process detach behaviour differs from `gnome-terminal`).
- Test coverage: `cargo test --workspace` does not cover live spawn behaviour; only argument construction and probe-order.

### `withEnvOverride` (`src/integrations/plugin-env-mutex.ts`) is documented non-reentrant (medium, mitigated)

- Files: `src/integrations/plugin-env-mutex.ts`.
- Why fragile: AGENTS.md (`AGENTS.md:120`): "process.env mutation in AO plugin loading goes through `withEnvOverride` ... It is not reentrant — two concurrent callers corrupt each other's env snapshot."
- Safe modification: Document-mandated. Don't `process.env`-poke from tracker / scm code; always go through the mutex.
- Test coverage: tests exist for the mutex itself; no test asserts that NO direct `process.env` writes happen in plugin code.

### `~/.relay/feed.jsonl` is the source of truth for chat history (medium)

- Files: `src/channels/channel-store.ts:622` (writer), `crates/harness-data/src/lib.rs:999-1018` (reader).
- Why fragile: Append-only (`AGENTS.md:111`). No rotation, no rewrite even for corrections. A bad write that lands as a malformed JSONL line is silently skipped by readers (`session-store-harness-store.test.ts:217-240`) — no reconciliation surface. For Phase 2's handoff brief synthesis, the feed is a key input; a corrupted line can degrade brief quality without the user knowing.
- Safe modification: post a correction entry; never edit. If a writer crashes mid-write, the partial line is silently dropped — a future "feed health check" surface might be valuable.

## Scaling Limits

### Per-process file lock semantics (medium)

- Current capacity: in-process Promise-chain mutex (`src/storage/file-store.ts:351-370`, `src/channels/channel-store.ts:35,42`). Safe for one orchestrator process.
- Limit: any second process (CLI invocation while the orchestrator is running, GUI + CLI, two CLI invocations) can race read-modify-write cycles.
- Scaling path: Postgres backend (issue #155, ROADMAP first bullet) replaces in-process locks with `pg_advisory_xact_lock` + `SELECT … FOR UPDATE`. The plumbing is in place (`src/channels/channel-store.ts:929-937` already routes coordination through `store.mutate` with that future in mind); the gap is wiring + tests.

### `feed.jsonl` is unbounded (low, deferred)

- Current capacity: bounded by disk; readers use `read_to_string` which loads the whole file into memory.
- Limit: very long autonomous runs (overnight + multi-hour) will accumulate large feeds. (verify) — no hard number measured; on a 30-second tool-use cadence, a 12-hour run is ~1,440 entries × ~2 KB each ≈ 3 MB, comfortable for `read_to_string` but worth measuring before relying on it for handoff briefs.
- Scaling path: rotation by date or by count; tail-only reads on the Rust side; an offset cursor.

### Decisions are one-file-per-id (low, by design)

- Current capacity: one `decisions/<id>.json` per decision. `load_channel_decisions` (`crates/harness-data/src/lib.rs:1157-1175`) reads them all on each call.
- Limit: linear in decision count per channel; for a channel with thousands of decisions, dashboard loads slow down.
- Scaling path: index file with last-N pointers; pagination at the loader. Not on the immediate roadmap.

## Dependencies at Risk

### `@aoagents/ao-core` is a third-party leaf-plugin dependency (low)

- Risk: tracker / scm / pr-poller integrations are built on Composio's `@aoagents/ao-core`. A breaking change there ripples through `src/integrations/`.
- Files: `src/integrations/` (multiple files), README "Acknowledgements".
- Impact: GitHub + Linear tracker integrations would need adapter updates.
- Migration plan: AO is owned by Composio; pin minor versions and watch their changelog. The notifier compatibility shim (`src/channels/ao-notifier.ts`) is one-way (Relay → AO), so a downstream-only change there is contained.

### `pg` driver and the never-tested Postgres backend (low, acknowledged)

- Risk: `pg` is in `package.json` for the stubbed Postgres path. Without an integration-tier CI run, dependency upgrades can break the unwired code path silently.
- Files: `src/storage/postgres-store.ts`, `src/storage/migrations/runner.ts`.
- Impact: the day someone wires Postgres end-to-end, they may discover the driver is stale.
- Migration plan: cover under issue #155 ("Wire the Postgres backend end-to-end").

## Missing Critical Features

### Token usage telemetry (the entire upcoming Phase 1)

- Problem: README "Known limits" bullet — "Cost guardrails not yet implemented. Token usage isn't tracked or capped." Adapter layer in `src/agents/cli-agents.ts` does not emit usage data, even though `TokenTracker` is fully implemented and connected to threshold events. See "Tech Debt" first item.
- Blocks: cost-tier work (issues #200-#203), context-window-bar UX, Phase 2 handoff (which depends on the 90% threshold event).

### Handoff brief synthesizer (the entire upcoming Phase 2)

- Problem: There is no `rly handoff` command, no brief synthesizer, no agent-authored gap hook. ROADMAP Phase 2 documents the goal.
- Blocks: clean provider switch (Claude ↔ Codex mid-task) and resume-after-a-week workflows.

### Schema-migration story for `~/.relay/` JSON files

- Problem: As above — there is no `schemaVersion` field on persisted Relay artifacts. Phase 2 brief artifacts that may live on disk for "a week" cannot be safely evolved without a versioning convention.

### Cost guardrails / per-run budget cap

- Problem: documented in README "Known limits" and ROADMAP "Cost guardrails (in design)". Prerequisite to making `RELAY_AUTO_APPROVE=1` safer for multi-hour runs.

## Test Coverage Gaps

### Postgres backend integration tests are skipped (high)

- What's not tested: `test/storage/postgres-store.integration.test.ts`, `test/storage/postgres-migrations.integration.test.ts` — both `describe.skip`.
- Files: as above.
- Risk: when someone wires the Postgres backend (issue #155), the implementation may have drifted from the test fixtures in subtle ways.
- Priority: Medium — bounded by the fact that the backend is unwired; fix when wiring.

### Live-network adapter tests are skipped (medium, by design)

- What's not tested: `test/cli/pr-watcher-factory.test.ts`, `test/integrations/github-projects-client.test.ts`, plus four others (`describe.skip` blocks).
- Files: 7 test files contain `describe.skip` / `test.skip`.
- Risk: real-API contract drift (Anthropic, OpenAI, GitHub, Linear) goes undetected until a user reports it.
- Priority: Low — by design (`AGENTS.md:50`). Mitigation is the integration tier in `.github/workflows/integration.yml` running these on a schedule. (verify) — confirm the integration workflow actually unskips these.

### Spawn paths on Linux/Windows have unit tests but no device tests (high, acknowledged)

- What's not tested: real-device behaviour of `spawn_agent_linux` / `spawn_agent_windows` (`gui/src-tauri/src/lib.rs:2668-2755`).
- Risk: the 7-binary probe chain may pick the wrong terminal under some `$DESKTOP_SESSION` configurations; SIGTERM kill may not detach from the grandchild on certain shells.
- Priority: High — gates cross-platform release. Tracked via README "Known limits" + Roadmap "Integration test coverage off macOS (in progress)".

### Cross-dashboard schema-drift tests do not exist (high)

- What's not tested: a CI check that asserts every field in `src/domain/*.ts` has a corresponding deserialization path in `crates/harness-data/src/lib.rs`. AGENTS.md mandates the convention but doesn't enforce it.
- Risk: the "TUI shows nothing" silent-failure class — adding a required field on the TS side and not the Rust side breaks dashboards in production with no test failure.
- Priority: High for the maturity goal; medium today (caught by manual review).

### No test asserts `record()` is called by adapters (high — for Phase 1)

- What's not tested: that any code path actually invokes `TokenTracker.record(...)` with real provider numbers.
- Files: would belong in `test/agents/cli-agents-streaming.test.ts` or `test/orchestrator/repo-admin-session-budget.test.ts`.
- Risk: this is exactly the gap that will be filled by Phase 1; flagging it here so the test surface is part of the plan, not an afterthought.
- Priority: High — Phase 1 prerequisite.

---

*Concerns audit: 2026-05-09*
