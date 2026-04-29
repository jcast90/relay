# Changelog

## 0.7.0

### Minor Changes

- GitHub Projects v2 tracker integration (v0.2). Channels project onto a GH Projects v2 board: channel → epic draft item, tickets → child draft items, with `Type` / `Status` / `Priority` custom fields kept in sync by a one-way Relay-authoritative sync worker. Drift on the GitHub side is logged to the channel feed as a `status_update` warning and overwritten on the next tick.

  Shipped slices (PRs A, B, C, D, E, G, H from the v0.2 milestone):
  - **GraphQL client + project resolver** (#188) — find-or-create-by-title, owner-id resolution for user vs org projects
  - **Draft-item CRUD + custom-field bootstrap** (#189) — create / update / archive draft items, idempotent Status/Type/Priority field creation with seeded options
  - **Channel ↔ epic orchestration** (#191) — `provisionEpicForChannel` / `renameEpicForChannel` / `archiveEpicForChannel` plus the `Channel.trackerLinks` shape (TS + Rust mirror with serde defaults for back-compat)
  - **One-shot sync worker** (#192) — `syncChannelTickets` reconciliation tick with title-drift detection, rate-limit throttling (default min budget 200), stale-id recovery (item-deleted-out-from-under-us repair), and `TicketLedgerEntry.externalIds` for foreign-key tracking
  - **Classifier URL parsing** (#190) — pasting a Projects v2 item URL into chat resolves the project + epic + creates the ticket; project-only URL pastes return a clear deferred-error message
  - **Tracker config block** (#198) — `tracker` block in `~/.relay/config.json` with `default` provider, per-provider settings (`github_projects` / `linear` / `github_issues` / `relay_native`), per-channel override via `rly channel update --tracker <name>` (or `none` to unpin), and `rly doctor` diagnostics (default-points-at-missing-provider errors, custom-field 50-option-cap warnings, footgun warnings)
  - **Documentation** (#197) — new `docs/trackers.md` reference with mapping tables, drift behavior, rate limits, troubleshooting; `docs/getting-started.md` adds a "Linking a channel to GitHub Projects v2" section; `README.md` notes the integration and adds `trackerLinks` to the file-layout tree

  Deferred to follow-up issues (gated behind the new `tracker` config block before any of them auto-fire):
  - **#193** MCP-handler wiring for `channel_create` / `channel_update` / `channel_archive` (high priority)
  - **#194** Scheduler / interval timer for `syncChannelTickets` (high priority)
  - **#195** Status-field drift detection
  - **#196** Bulk-import an existing GH Projects v2 board into a fresh channel
  - **#185** Linear parity (PR F — analogous mapping onto Linear projects + sub-issues)

  Migration: configs that predate v0.2 have no `tracker` block; `readConfig` synthesizes the default (`relay_native`, offline-first) so no user action is required. Existing `linear-mirror.ts` users keep working unchanged until #185 lands.

  Test count: 905 → 978 across the v0.2 work. Full Rust workspace passes `cargo check` + `cargo test` for `harness-data`.

## 0.5.1

### Patch Changes

- Tidewater polish:
  - Sidebar **Threads** count now excludes archived channels and DM-kind channels — was inflating with historical DMs and retired channels. Only active, channel-kind entries count as threads.
  - Sidebar **Running** row re-scoped from a counter (which always capped at 1 in a single-center-pane shell) to a presence signal — pulse dot when a stream is live, dimmed when idle.

## 0.5.0

### Minor Changes

- Backend-adjacent Tidewater completion:
  - **LLM classifier → Channel.tier**: The orchestrator's `ClassificationResult` now refines the heuristic tier seed whenever a run dispatches into a channel. New `classifierTierToChannelTier` mapper collapses the 6-variant `ComplexityTier` onto the 5-variant `ChannelTier` header pill (`architectural` + `multi_repo` → `feature_large`; `trivial` → `chore`; `feature_small` → `feature`). Best-effort update — a write failure logs but doesn't fail the run.
  - **Absent-repo mention warning**: Composer scans the drafted message for `@alias` tokens that match a registered-but-unattached workspace and surfaces a pre-send warning banner with a one-click Attach action per offender. The user can still send as-is; the warning is advisory.
  - **Channel.tier / starred / kind** now first-class on the TS `Channel` interface (previously Rust-only on-disk, back-compat via serde defaults).

  Tests: 4 new for `classifierTierToChannelTier`.

## 0.4.0

### Minor Changes

- Final Tidewater polish — every deferred item from v0.3.0 shipped.
  - **Tier auto-classification**: heuristic classifier in `harness-data` stamps `Channel.tier` on create based on name + description keywords. Manual override in the About tab still wins; the real orchestrator classifier can refine later.
  - **Sidebar Threads / Running** now show real counts. Threads = total sessions across all channels (new `list_session_counts` Tauri command). Running = live chat-stream count pushed up from CenterPane.
  - **Appearance settings** (§8.3): new Settings section with Avatar style (glyph | initial) and Density (compact | medium | spacious). Persists to `localStorage`, applied across all surfaces via a `useAppearance()` hook.
  - **`UiChannel.repos` dual-repr dropped**: single source of truth is `repoAssignments`. Callers use `channelAliases(ui)` for a flat alias list and `mentionContext(ui)` for the renderer.
  - **Gui-local vitest** with 11 `renderWithMentions` tests covering primary/attached/human chip classification, case-insensitivity, bold, code, and mixed-token tokenization. Root `pnpm test` chains to `pnpm -C gui test` so CI runs both.
  - 5 new Rust tests for `classify_tier_heuristic`; `Channel.kind` handled in existing harness-data test fixtures.

## 0.3.0

### Minor Changes

- Tidewater v2 — feature-complete pass. DMs land as a first-class surface, attach-on-command inlines repo attachment from the composer, and agent avatars gain deterministic glyphs + color hashes. Inter + JetBrains Mono now ship as bundled .woff2 files for offline deployments.

  **DMs (§4.6, §5.2, §8.1, §8.2)**
  - New `✉ Direct messages` sidebar section with a per-DM list and `+` button
  - `NewDmModal` — pick a workspace, mint a DM-kind channel
  - `DmView` — hides tabs, shows a yellow "kickoff surface" banner, Promote-to-channel CTA
  - `/new` slash command in the DM composer → opens PromoteDmModal
  - `PromoteDmModal` — rename + attach additional repos + flip kind to "channel", preserving all existing DM history
  - Backend: `Channel.kind: Option<String>` ("channel" | "dm", back-compat default)
  - New Tauri commands: `create_dm`, `promote_dm`
  - DMs reuse the full channel infrastructure (sessions, rewind, streams, mentions) so the only delta is sidebar segregation + chrome

  **Attach-on-command (§8.4)**
  - Composer's `MentionPopover` now surfaces an "Attach @foo" row when the typed alias matches a registered workspace that's not attached to the current channel. One click attaches via `updateChannelRepos` and inserts the mention.

  **Agent glyphs + color hash**
  - `agentAvatar(agentId, displayName)` derives a deterministic glyph (◆ ▲ ● ■ ◈ ▼ ◉ ◇ ★ ☗ ✦ ✧ ♆ ♄ ♃ ♇) and HSL background per agent. Renders in the channel header agent stack and per-message avatars.

  **Bundled fonts**
  - `gui/public/fonts/Inter.woff2` (variable) and `JetBrainsMono.woff2` ship with the bundle. `@font-face` prefers them over OS fallbacks.

  **Sidebar shell**
  - Activity / Threads / Running nav rows scaffolded at the top of the sidebar with Activity wired to a real count (channels updated < 1h ago). Threads/Running remain visual-only for this release — cross-channel state aggregation is a follow-up.

  **Deferred**
  - Tier auto-classification — field + manual selector ship, classifier integration is a separate backend change
  - `renderWithMentions` JSX unit test — needs React-at-root or a gui-local vitest config
  - Visual tweaks panel (§8.3) — handoff notes it as non-essential
  - `UiChannel` dual-repr — pragmatic keep

## 0.2.0

### Minor Changes

- 4351a32: OSS-20: release pipeline. Adds Changesets-driven versioning with a Cargo.toml
  sync script, `.github/workflows/release.yml` that publishes to npm + cuts
  per-OS GUI artifacts (`.dmg`, `.AppImage`, `.deb`, `.msi`) + creates a GitHub
  Release on `v*` tags. `install.sh` gains a Tauri-dep preflight on Linux with
  an interactive `apt-get install` offer. README has a proper Install section
  with the `npm install -g @jcast90/relay` / `npx @jcast90/relay welcome`
  one-liner (package is `@jcast90/relay` because unscoped `relay` and `rly`
  are taken on npm — see OSS-21).
- Tidewater GUI rebuild. The Tauri desktop GUI has been rewritten end-to-end against a new design (ink/paper palette, Slack-style chat shell, interactive repo-chip row, 3-step new-channel wizard, global Settings page with pluggable ticket provider, and a right rail with Threads / Decisions / PRs tabs). Existing behaviors preserved: rewind, spawn-to-Terminal, archive/unarchive, pending-plan approval CTA, tracked PRs, mention autocomplete.

  **Backend additions**
  - `Channel.tier` (`feature_large | feature | bugfix | chore | question`) and `Channel.starred` — both optional with `#[serde(default)]` so older channel files keep deserializing.
  - `GuiSettings` persisted to `~/.relay/gui-settings.json`. Ticketing provider (`relay | linear | none`) selects whether the BoardView renders Linear-sourced tickets.
  - New Tauri commands: `set_channel_starred`, `set_channel_tier`, `set_primary_repo`, `get_settings`, `update_settings`.

  **Breaking UI change**
  - Message bodies no longer render GFM (no tables, no fenced code blocks). `renderWithMentions` is the single render path per the design spec — recognises `@alias`, `**bold**`, and inline `` `code` `` only.
  - Removed deps: `react-markdown`, `remark-gfm`.

All notable changes to **Relay** (`rly`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Workspace versions are kept in lockstep across the npm package
(`@jcast90/relay`), the Tauri GUI frontend (`gui/package.json`), and every
`Cargo.toml` in the workspace (`tui/`, `gui/src-tauri/`,
`crates/harness-data/`). The `pnpm changeset-version` script runs
`changeset version` then `scripts/sync-versions.mjs` to keep them aligned.

## [Unreleased]

_Nothing yet._

## [0.1.2] - 2026-04-22

### Fixed

- Release workflow now uploads Tauri GUI bundles to the GitHub Release.
  The upload glob pointed at `gui/src-tauri/target/release/bundle/...`
  but this is a Cargo workspace with a shared `target/` at the repo
  root, so Tauri's actual output (`target/release/bundle/...`) was
  being silently dropped by `upload-artifact`'s `if-no-files-found: warn`.
  The `v0.1.0` and `v0.1.1` releases shipped with zero installers; this
  is the first release with `.dmg` / `.AppImage` / `.deb` / `.msi`
  downloads attached.

### Changed

- README: removed the "coming soon" banners now that npm publish is
  live; documented that pre-release GUI installers are unsigned.

## [0.1.0] - 2026-04-22

First public OSS release. Everything below was done under the `OSS-01..23` hardening +
launch-prep push; there was no prior tagged release, so this is the initial one.

### Added

- **OSS-05** — CLI / TUI / GUI parity for rewind, plan-approval, and PR-status
  surfaces. All three dashboards read the same `~/.relay/` state.
- **OSS-06** — Streaming tool-use parity. CLI inline activity during a stream;
  TUI renders a stacked view of in-flight calls.
- **OSS-07** — Docs + onboarding pass. `rly welcome` scaffolds
  `~/.relay/config.env` from a template; README MCP-tool list corrected.
- **OSS-09** — Test infrastructure. `harness-data` unit tests; CI gains a
  dedicated integration tier alongside the scripted tier on every PR.
- **OSS-10** — Cross-platform terminal-tab spawn. macOS (`osascript`), Linux
  (`$TERMINAL` probe with fallback chain), and Windows (`wt.exe` → `powershell`
  → `cmd`); no-supported-terminal fallback posts a system channel entry.
- **OSS-16** — README tagline refresh + docs sync.
- **OSS-20** — Release pipeline: Changesets-driven versioning with a Cargo sync
  script, `.github/workflows/release.yml` that (when enabled via
  `NPM_PUBLISH_ENABLED`, see OSS-21 below) publishes to npm + always builds
  per-OS GUI artifacts (macOS `.dmg`, Linux `.AppImage` + `.deb`, Windows
  `.msi`) + cuts a GitHub Release on `v*` tags. `install.sh` gained a preflight
  that checks for `node >= 20`, `pnpm`, `cargo`, and the Linux Tauri system
  libraries.
- **OSS-22** — Pre-announce polish: `rly --help` expanded to cover all wired
  commands (grouped by area); `.github/ISSUE_TEMPLATE/config.yml` routes
  security reports; phantom `docs/cloud-execution.md` reference removed;
  `prettier` added to `devDependencies` for fresh-clone `pnpm format:check`.
- **OSS-23** — GitHub repo metadata (description, homepage, 10 topics);
  private vulnerability reporting enabled; Discussions enabled.

### Changed

- **OSS-01** — Rewind hardening. JSON injection resistance, rollback integrity,
  mid-stream abort handling, orphan-ref cleanup, expanded tests.
- **OSS-02** — Tauri IPC hardening. `run_cli` enforces a strict command
  allowlist; IDs are validated; activity-cap pre-append prevents GUI memory
  growth.
- **OSS-03** — Subprocess env whitelist + MCP non-loopback hard-stop. Child
  processes get a scrubbed env by default (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
  AWS creds, anything matching `SECRET_NAME_PATTERN` stripped). `rly serve`
  refuses non-loopback binds without a token unless
  `--allow-unauthenticated-remote` is passed.
- **OSS-04** — Surface silent observability failures. Sinks that fail now
  surface through the system channel.
- **OSS-08** — Wire-or-delete cleanup. Removed unreachable pod-executor code,
  stale `crosslinkRepos` dead code, and dropped the orphaned
  `@kubernetes/client-node` dependency.
- **OSS-14** — Package correctness: moved `zod` to runtime deps (fresh
  `npm install --omit=dev` now works), tightened `.env*` gitignore patterns,
  and shipped the first top-level `rly --help` (expanded further in OSS-22).
- **OSS-18** — Prettier reset + `pnpm format:check` blocking in CI. `prettier`
  added to `devDependencies` so fresh clones get a clean `format:check` out of
  the box.

### Security

- **OSS-15** — Purged personal references from committed files.
- **OSS-17** — Security polish. Config files written by `install.sh` are
  `chmod 600` on creation; `~/.relay/config.env` permissions preserved on
  re-install.
- **OSS-21** — Launch-blocker fixes surfaced during OSS-01..20 review.

### Fixed

- **OSS-11** — Flaky-test stabilization: orchestrator tests now consistently
  run under scripted mode regardless of the host shell's `HARNESS_LIVE` value.
- **OSS-21** — Second flake pass on `verification-override-feed.test.ts` and
  the orchestrator-v2 channel-mirror assertions: replaced single-snapshot
  reads of the channel feed / board with a short polling helper so
  atomic-rename visibility on Linux CI can't race the assertion.

### Infrastructure

- **OSS-13** — CI stabilization: `rust-check` now installs Tauri system libs
  and runs the full `cargo test --workspace`.
- **OSS-19** — Removed all legacy `agent-harness` references (bin alias,
  `~/.agent-harness` auto-migration, `AGENT_HARNESS_*` env fallbacks, doc
  mentions). `rly` is the sole CLI; `~/.relay/` is the sole data path.
- **OSS-21** — Launch-blocker triage:
  - Storage: `HARNESS_STORE=postgres` no longer throws. The factory warns
    once and falls back to the file backend so old docs / scripts don't
    crash. The `PostgresHarnessStore` source stays in-tree as a stub for
    the Roadmap (multi-agent coordination via `LISTEN/NOTIFY`) — it is no
    longer claimed as a shipping backend anywhere in docs.
  - npm: package name changed from unscoped `relay` to `@jcast90/relay`
    (both `relay` and `rly` were taken on npm). Scope is permanent.
  - Release pipeline: `release-npm` is now gated on the repo variable
    `NPM_PUBLISH_ENABLED` so the job is a safe no-op until an admin
    explicitly enables it. `release-gui` and `release-github` no longer
    depend on `release-npm` — GUI bundles and the GitHub Release ship on
    every tag regardless of npm publish state.

[Unreleased]: https://github.com/jcast90/relay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jcast90/relay/releases/tag/v0.1.0
