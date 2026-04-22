# Changelog

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
