# Testing Patterns

**Analysis Date:** 2026-05-09

Authoritative sources: [`AGENTS.md`](../../AGENTS.md), [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`CI.md`](../../CI.md), and the workflow files under `.github/workflows/`. Verified by sampling under `test/`, `gui/src/components/`, and `crates/harness-data/`.

## Test Frameworks

**TypeScript orchestrator (root):**
- **Vitest 3.x** (`vitest: ^3.2.4` in `package.json`). Runner config: `vitest.config.ts` at repo root.
- Vitest globals are enabled implicitly via `tsconfig.json` `"types": ["node", "vitest/globals"]`, but actual test files import `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` explicitly from `"vitest"`. Match that style — don't rely on globals.
- No assertion library beyond Vitest's built-in `expect`. No Jest.

**GUI frontend (`gui/`):**
- Vitest 3.x with `@vitejs/plugin-react`, jsdom environment, `globals: true`.
- Config: `gui/vitest.config.ts`. Setup file: `gui/src/test-setup.ts` (registers `@testing-library/jest-dom/vitest` matchers and an `afterEach(cleanup)`).
- React Testing Library: `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`.

**Rust workspace (`tui/`, `gui/src-tauri/`, `crates/harness-data/`):**
- `cargo test` (built-in). `tempfile` is the only test-time dep listed (`crates/harness-data/Cargo.toml`, `gui/src-tauri/Cargo.toml`). No `proptest`, no `mockall`.

**Run commands:**
```bash
# Root TS + orchestrator
pnpm test                              # vitest run, scripted-mode default
pnpm typecheck                         # tsc --noEmit
pnpm build                             # tsc -p tsconfig.build.json + migration copier

# GUI tests (separate workspace; root vitest excludes gui/**)
pnpm -C gui test                       # or `cd gui && pnpm test`
pnpm test:gui                          # convenience script that does pnpm install + test

# Rust workspace
cargo check --workspace                # required after Rust edits in tui/, gui/src-tauri/, crates/
cargo test --workspace                 # CI also runs this; locally if Rust changed

# Targeted run
pnpm test test/orchestrator/ticket-router.test.ts

# Local format check (matches CI)
pnpm format:check
```

The full pre-push verification recommended by `AGENTS.md`:
```bash
pnpm test && pnpm typecheck && pnpm build
# plus, if any Rust changed:
cargo check --workspace
# plus, if any gui/ frontend file changed:
cd gui && pnpm build
```

## Test File Organization

**Orchestrator (root):**
- Tests live in `test/`, mirroring `src/`. Per AGENTS.md: "`test/` mirrors `src/`". Examples:
  - `src/orchestrator/ticket-router.ts` ↔ `test/orchestrator/ticket-router.test.ts`
  - `src/channels/channel-store.ts` ↔ `test/channels/channel-store.test.ts`
  - `src/storage/file-store.ts` ↔ `test/storage/file-store.test.ts`
- Some legacy/cross-cutting tests sit at the top level of `test/` (`test/orchestrator-v2.test.ts`, `test/classification.test.ts`, `test/failure-routing.test.ts`).
- Top-level test directories: `test/agents/`, `test/approvals/`, `test/budget/`, `test/channels/`, `test/cli/`, `test/crosslink/`, `test/domain/`, `test/execution/`, `test/fixtures/`, `test/gui-lib/`, `test/integrations/`, `test/lifecycle/`, `test/mcp/`, `test/orchestrator/`, `test/storage/`.
- Naming: `<thing>.test.ts`. Integration suites: `<thing>.integration.test.ts` (e.g. `test/storage/postgres-store.integration.test.ts`).

**GUI frontend:**
- Tests are **co-located** with the component. `gui/src/components/Sidebar.test.tsx`, `gui/src/components/PromptModal.test.tsx`, `gui/src/lib/mentions.test.tsx`. Different from the orchestrator convention.

**Fixtures:**
- `test/fixtures/legacy-*` directories hold golden on-disk snapshots used to verify backwards-compat readers (legacy channel layout, legacy workspace registry, legacy session, etc.).

**Vitest exclude:**
- The root `vitest.config.ts` excludes `node_modules/`, `dist/`, `gui/**`, and `.claude/worktrees/**`. The GUI gets its own runner because its deps (`react`, `@testing-library/*`) are only installed inside `gui/`.

## Test Structure

**Orchestrator suite skeleton:**
```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import { TicketRouter } from "../../src/orchestrator/ticket-router.js";
import { FileHarnessStore } from "../../src/storage/file-store.js";

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;

describe("TicketRouter", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "relay-test-"));
  });

  afterEach(async () => {
    await rm(workDir, RM_OPTS);
  });

  it("dispatches ready tickets through the resolver", async () => {
    // …
  });
});
```

**GUI component suite skeleton:**
```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  api: { listSections: vi.fn().mockResolvedValue([]), /* … */ },
}));

import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("opens the new-channel modal", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);
    await user.click(await screen.findByRole("button", { name: /create new/i }));
    // …
  });
});
```

**Patterns:**
- **Per-test tmp dirs** for anything that touches the filesystem: `await mkdtemp(join(tmpdir(), "<prefix>-"))` in `beforeEach`, `await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })` in `afterEach`. The `maxRetries`/`retryDelay` options matter on Linux CI where atomic tmp-rename can race a `readdir` (see `test/orchestrator-v2.test.ts:18–26` for the canonical commentary).
- **Defensive `waitFor` polling** for cross-process visibility (`test/orchestrator-v2.test.ts:29–56`). Used when an atomic rename may not be visible to a fresh `readdir` immediately. Default budget 2000ms / 20ms intervals.
- **Hand-rolled fakes over auto-mocks** for orchestrator boundaries: `FakeSpawner`, `FakeAdmin`, `FakeWorkerHandle` in `test/orchestrator/ticket-router.test.ts` and `test/orchestrator/ticket-runner.test.ts`. They implement the smallest interface the unit-under-test consumes — no full session machinery.
- **`FileHarnessStore` for storage**, **`ChannelStore` for feed/ticket state**, **`ScriptedInvoker` for command execution.** Tests wire these together directly — no DI container, no test harness factory beyond per-test helper functions.

## Mocking

**Framework:** Vitest's built-in `vi` (`vi.mock`, `vi.fn`, `vi.spyOn`, `vi.clearAllMocks`).

**Patterns:**

```typescript
// GUI: module-level mock for Tauri-bridged modules (jsdom has no IPC).
vi.mock("../api", () => ({
  api: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    createSection: vi.fn().mockResolvedValue({ sectionId: "sec-new", /* … */ }),
  },
}));

vi.mock("../lib/dialogs", () => ({
  confirmAction: vi.fn().mockResolvedValue(true),
  notifyError: vi.fn().mockResolvedValue(undefined),
}));
```

```typescript
// Orchestrator: hand-rolled fakes implementing the production interface.
class FakeSpawner implements RepoAdminProcessSpawner {
  readonly byAlias = new Map<string, FakeChild[]>();
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess { /* … */ }
}
```

**What to mock:**
- The Tauri IPC layer (`gui/src/api.ts`, `gui/src/lib/dialogs.ts`) — required because jsdom has no Tauri bridge.
- Subprocess spawn / command invocation. Production wiring goes through `CommandInvoker`; tests inject `ScriptedInvoker` (`src/simulation/scripted-invoker.ts`) or a hand-rolled fake.
- External services (GitHub API, Linear API, Postgres). Live-network paths sit inside `describe.skip(...)` and run only in the integration tier.

**What NOT to mock:**
- The filesystem. Tests use real per-test tmp dirs and the real `FileHarnessStore` / `ChannelStore`. This catches atomic-rename and serialization bugs that mocked filesystems hide.
- Domain types / zod schemas. Construct real instances.
- The orchestrator pipeline itself in unit tests. Each stage class is exercised against real collaborators (with scripted invokers) — see `test/orchestrator-v2.test.ts:58–80` for the production-shape wiring.

## Scripted Mode (the default test invariant)

**`HARNESS_LIVE` unset = scripted mode.** AGENTS.md and CONTRIBUTING.md both call this out explicitly:

- With `HARNESS_LIVE` unset, the orchestrator routes commands through `ScriptedInvoker` (`src/simulation/scripted-invoker.ts`). It produces deterministic JSON responses keyed off the prompt's `Work kind` field. No real `claude` / `codex` / `gh` / network calls.
- Orchestrator tests **assume** scripted mode. If an orchestrator test is flaky, AGENTS.md's first-suspect is "something is accidentally reading `process.env.HARNESS_LIVE` from the host shell."
- Set `HARNESS_LIVE=1` only when specifically debugging adapter plumbing.

The fast PR CI tier runs with `HARNESS_LIVE` unset (see `.github/workflows/ci.yml`); the integration tier explicitly sets `HARNESS_LIVE: "1"` for the `pr-watcher-live` job (`.github/workflows/integration.yml:160`).

## Live-Network and Integration Suites

**Convention:** Tests that hit real services sit inside `describe.skip(...)` blocks. Examples:

- `test/cli/pr-watcher-factory.test.ts:374 describe.skip("createPrWatcherFactory — live network (requires GITHUB_TOKEN)", …)`
- `test/integrations/github-projects-client.test.ts:336 describe.skip("github-projects/client (live network)", …)`

**Env-gated `describe`:** suites that need a side-effecting service but no secret use a guarded selector:

```typescript
const TEST_URL = process.env["HARNESS_TEST_POSTGRES_URL"];
const maybeDescribe = TEST_URL ? describe : describe.skip;
maybeDescribe("postgres-store integration", () => { /* … */ });
```

(`test/storage/postgres-store.integration.test.ts:19–29`, `test/storage/postgres-migrations.integration.test.ts:17–21`, `test/execution/git-worktree-sandbox.test.ts:494–496`.)

These never run in the default `pnpm test` sweep — they need the env var or `describe.skip` toggled.

## Two CI Tiers

Documented in detail in [`CI.md`](../../CI.md). Summary:

### Tier 1 — fast PR CI (`.github/workflows/ci.yml`)

Runs on every push to `main` and every PR. Scripted-mode only. Finishes in under a minute on a cold cache.

Jobs:
- **`ts-verify`** — `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `cd gui && pnpm install --frozen-lockfile && pnpm build`, `cd gui && pnpm test`. Node 22, pnpm 10.
- **`rust-check`** — `cargo check --workspace --locked` + `cargo test --workspace`. Linux runner; installs Tauri system deps (`libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).
- **`format-check`** — `pnpm dlx prettier --check 'src/**/*.{ts,tsx}' 'test/**/*.{ts,tsx}' 'gui/src/**/*.{ts,tsx}' 'scripts/**/*.{ts,mts}' '*.md' 'docs/**/*.md'`. Also greps `gui/src` for `window.{prompt,confirm,alert}(` and fails if any matches (Tauri WKWebView no-op guard).

`HARNESS_LIVE` is unset throughout, so the orchestrator runs scripted and `describe.skip` integration suites stay skipped. This is the deterministic path reviewers see on every PR.

### Tier 2 — integration (`.github/workflows/integration.yml`)

Triggers: cron `0 6 * * *` (06:00 UTC nightly) and `workflow_dispatch` with a `suites` input (`all|postgres|git|pr-watcher`).

| Job | Unskip flag | External service | Secret |
|---|---|---|---|
| `postgres-integration` | `HARNESS_TEST_POSTGRES_URL` | Postgres 16 service container | none — provisioned inline |
| `git-worktree-integration` | `RELAY_TEST_REAL_GIT=1` | system `git` | none |
| `pr-watcher-live` | `GITHUB_TOKEN`, `HARNESS_LIVE=1` | github.com | `INTEGRATION_GITHUB_TOKEN` |

Jobs whose secret isn't set print a "Skip — …" notice and exit 0, so the workflow stays green until an admin provisions them.

**Run integration locally:**
```bash
HARNESS_TEST_POSTGRES_URL=postgres://postgres@localhost:5432/relay_test \
  pnpm test test/storage/postgres-store.integration.test.ts test/storage/postgres-migrations.integration.test.ts

RELAY_TEST_REAL_GIT=1 pnpm test test/execution/git-worktree-sandbox.test.ts
```

## Coverage

**Requirements:** None enforced. No coverage tooling configured (no `c8`, no `@vitest/coverage-*` dep, no `coverage` script in `package.json`, no coverage step in CI). Tests pass / fail; no coverage gate.

If you need ad-hoc coverage, install `@vitest/coverage-v8` locally and run `pnpm vitest run --coverage`. Don't commit it without discussion — there's no coverage culture in this repo today.

## Test Types

**Unit tests (orchestrator):**
- One stage class at a time, wired against real collaborators (`ChannelStore` over a tmp dir, `FileHarnessStore` over a tmp dir, `ScriptedInvoker`) and minimal hand-rolled fakes for the spawn boundary. See `test/orchestrator/ticket-router.test.ts` and `test/orchestrator/ticket-runner.test.ts` for the canonical shape.
- Domain tests are pure (`test/domain/`, `test/classification.test.ts`) — no I/O.

**End-to-end orchestrator tests:**
- `test/orchestrator-v2.test.ts` wires the full pipeline (`AgentRegistry` + `createLiveAgents` + `ScriptedInvoker` + `LocalArtifactStore` + `VerificationRunner` + `OrchestratorV2`) over a tmp dir and exercises the run-level behaviour.

**GUI component tests:**
- Render + RTL queries. Five files today: `Sidebar.test.tsx`, `AutonomousSessionHeader.test.tsx`, `NewChannelModal.test.tsx`, `PromptModal.test.tsx`, `lib/mentions.test.tsx`. Treat these as **regression guards for Tauri-WKWebView-specific UI bugs** (per the comment in `.github/workflows/ci.yml:54–58`).

**Rust tests:**
- `cargo test --workspace` runs unit tests inside `crates/harness-data/`, `tui/`, and `gui/src-tauri/`. The GUI Rust backend (`gui/src-tauri/src/lib.rs`) embeds `#[cfg(test)] mod` blocks at the bottom of the file (e.g. the `resolve_rly_bin` and `augmented_child_path` regression tests around line 3351+).
- `tempfile` is used for filesystem-touching tests.
- Linux/Windows GUI agent-spawning paths are compile-checked via `cargo check --workspace` but only smoke-tested in CI — real-device coverage is the integration gate before release (see `AGENTS.md` "Things to watch out for").

**E2E:**
- No Playwright, no Cypress, no end-to-end browser harness. Manual verification per PR test plan.

## Anti-Patterns (banned)

- **No snapshot tests for orchestrator output.** Both AGENTS.md and CONTRIBUTING.md call this out: assert on shape (ticket count, status transitions, specific fields), not on stringified blobs. Orchestrator output evolves; snapshots turn every legitimate plan-shape change into churn. There are zero `toMatchSnapshot` calls in `test/`.
- **No flipping `HARNESS_LIVE=1` in default CI paths.** Live-network suites stay inside `describe.skip` so the fast tier is deterministic.
- **No `rm -rf` outside your own tmp dir.** Tests must never touch a real `~/.relay/`.
- **No `window.prompt`/`confirm`/`alert` in `gui/src/`** — caught by the format-check CI job.
- **No drive-by reformats** in test files (same as src).

## Common Patterns

**Async testing:**
```typescript
it("drains a ready ticket", async () => {
  const result = await runner.drainOnce();
  expect(result.processed).toBe(1);
});
```
Use `await` directly. No `done` callbacks, no `then()` chains.

**Polled assertions:**
```typescript
await waitFor(async () => {
  const entries = await readFeed(feedPath);
  return entries.find((e) => e.type === "ticket-completed") ?? false;
}, { timeoutMs: 2000, label: "ticket-completed entry" });
```
Use the in-file `waitFor` helper from `test/orchestrator-v2.test.ts` (or copy its shape) when an atomic-rename write may not be visible to a fresh `readdir` immediately. Mirror the pattern; don't use `setTimeout` polling ad-hoc.

**Error testing:**
```typescript
await expect(scheduler.enqueue(badTicket)).rejects.toThrow(/dependency cycle/);
```

**Filesystem cleanup:**
```typescript
const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;
afterEach(async () => { await rm(workDir, RM_OPTS); });
```

**Module mocks (GUI):**
```tsx
vi.mock("../api", () => ({ api: { listSections: vi.fn().mockResolvedValue([]) } }));
import { ComponentUnderTest } from "./ComponentUnderTest";  // import AFTER vi.mock
```
`vi.mock` is hoisted, but the `import` of the unit-under-test must follow the mock declarations to keep the read order obvious to humans.

---

*Testing analysis: 2026-05-09*
