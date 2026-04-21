# Testing

Conventions and patterns for writing tests in this repo.

> TODO: expand as needed. Add patterns here the first time you notice an agent writing tests inconsistent with the rest of the suite.

## The rules

- **Vitest**, in `test/` mirroring `src/`. New behaviour needs a test; new bugs need a regression test first.
- **Live-network tests** (anything hitting real Claude / Codex / GitHub / Linear) sit inside `describe.skip(...)`. They're opt-in and not part of default CI.
- **Scripted is default.** With `HARNESS_LIVE` unset, orchestrator code uses `ScriptedInvoker` from `src/simulation/`. This is how every orchestrator test runs. Fast and deterministic.
- **No snapshot tests for orchestrator output.** Assert on shape — ticket count, status values, specific fields. Stringified-blob snapshots turn every legitimate plan-shape change into churn.
- **Per-test tmp dirs.** Tests that persist anything create their own tmp directory (see existing tests for the pattern) and clean it up. **Never `rm -rf` outside the test's own tmp dir.** No test touches real `~/.relay/`.

## Patterns used in the codebase

Read a couple of these to see the house style:

- `test/orchestrator/` — scheduler / planner / decomposer tests using `ScriptedInvoker`.
- `test/channels/channel-store.test.ts` — file-store writes, atomic-rename expectations.
- `test/integrations/plugin-env-mutex.test.ts` — the pattern for testing `withEnvOverride` reentrancy.
- `test/execution/local-child-process-executor.test.ts` — spawning child processes against a mock.

## Scripted vs live

```bash
# default: scripted, no real API calls, no money spent
pnpm test

# live: real Claude/Codex/GitHub/Linear. Only when testing adapter plumbing.
HARNESS_LIVE=1 pnpm test
```

If a test that used to pass starts failing after an orchestrator change, first check whether it's accidentally live — `process.env.HARNESS_LIVE` leaking from your shell, or a test forgetting to reset it.

## Rust tests

```bash
cargo check --workspace     # cheap typecheck across all three crates
cargo test --workspace      # runs tui / gui / harness-data tests
```

Required whenever you touch `tui/`, `gui/src-tauri/`, or `crates/`.
