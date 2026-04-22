# Contributing to Relay

Practical notes for sending a patch. The README's **Contributing** section is the short version of this file.

## Before you start

For anything beyond a typo or a single-file fix, open an issue first. A 5-line sketch of what you want to change and why saves everyone time — especially for anything touching the orchestrator (classifier / planner / decomposer / scheduler), the MCP tool surface, or the `HarnessStore` interface. Small bugfixes, doc edits, and self-contained refactors can go straight to a PR.

## Development setup

```bash
pnpm install && pnpm test
```

That's the loop. For a deeper tour of the pieces — channels, sessions, runs, tickets, dashboards — read [`docs/getting-started.md`](./docs/getting-started.md).

A note on how `rly` runs: `bin/rly.mjs` invokes `src/cli.ts` through `tsx`, so edits to TS source are live on the next `rly …` invocation — no rebuild. Set `RELAY_USE_DIST=1` if you specifically want to exercise the pre-built `dist/` output (slightly faster startup, but stale until you `rly rebuild` / `pnpm build`).

## Local verification

Before you push, run:

```bash
pnpm test && pnpm typecheck && pnpm build
```

If your change touches any Rust code (`tui/`, `gui/src-tauri/`, `crates/`), also run:

```bash
cargo check --workspace
```

`pnpm test` is vitest; it should complete in well under a minute. `pnpm build` runs `tsc -p tsconfig.build.json` and the migration copier — it needs to pass for the published `dist/` to work.

## Branch and commit conventions

Looking at the commit log is the fastest way to match the house style — but concretely:

- Short imperative title. Scope-prefix with a module or ticket tag (`T-104:`, `gui:`, `rly rebuild:`) when it helps readers scan.
- Body explains the **why**, not a diff summary. Readers can see the diff; they can't see your reasoning.
- No Conventional Commits spec, no emoji, no ticket-reference footers beyond the internal `T-###` shorthand.
- If the change was AI-assisted, keep the `Co-Authored-By:` footer Claude adds. It's an honest provenance signal.
- Branch names are free-form; recent branches use `feat/<short-slug>` or `feat/t-###-<slug>`. Match what's there.

Prefer multiple small commits with coherent titles over one `"wip"` blob squashed at merge time.

## PR conventions

- **One logical change per PR.** If you touched two unrelated things, split them.
- Update documentation (README, `docs/getting-started.md`, inline doc comments) in the same PR whenever behavior or the CLI surface changes.
- Put a **Test plan** checklist at the end of the PR body — the commands you ran, the manual flows you exercised (e.g. "spun up `rly claude`, pasted a GitHub issue URL, watched board move to completed"). PRs without a test plan get sent back.
- Call out behavior changes loudly. If you change a default, a config var, or a file layout under `~/.relay/`, say so in the summary.
- If the PR is AI-assisted, leave the co-author footer on the commits and mention it in the body.

## Testing conventions

- Vitest, in `test/` mirroring `src/`. New behavior needs a test; new bugs need a regression test first.
- Live-network tests (anything hitting real Claude / Codex / GitHub / Linear) sit inside `describe.skip(...)` blocks. Don't enable them in default CI paths.
- **No snapshot tests for orchestrator output.** Assert on shape — ticket count, status transitions, specific fields — not on stringified blobs. Orchestrator output evolves; snapshots turn every legitimate change into churn.
- `HARNESS_LIVE=1` switches from the scripted `ScriptedInvoker` to real Claude/Codex spawns. Leave it off for unit work — scripted mode is fast and deterministic. Turn it on only when you're specifically testing adapter plumbing.

## Style

- Two-space indent, double quotes, semicolons, trailing commas where the language allows them.
- No linter config is enforced in CI. Run your editor's built-in formatter on files you touch; leave untouched files alone (no drive-by reformats in a feature PR).
- Keep imports tidy — no unused, grouped roughly as node-builtin / dep / local.

## Changes that span the dashboards

The CLI, TUI, and GUI all read the same files under `~/.relay/`. If you change the data model the CLI writes, the Rust side needs to keep up:

- Update `crates/harness-data/src/lib.rs` (the shared Rust types consumed by both `tui/` and `gui/`) in the same PR. Otherwise the TUI or GUI will silently drop fields or fail to parse.
- If you add an MCP tool, update the **MCP tools** section in `README.md` and mention it in the PR summary. `rly inspect-mcp` is the authoritative live list, but the README count is what people grep for.
- If you change the file layout under `~/.relay/`, update the **File layout** tree in `README.md` too.

## Filing issues

Use the forms under `.github/ISSUE_TEMPLATE/`:

- **Bug report** for something not working as documented.
- **Feature request** for new capabilities or UX changes.

The templates ask the questions we'll otherwise have to ask you anyway — filling them in upfront shortens the round-trip.

## Security issues

If you think you've found a security issue, **don't open a public issue**. Use GitHub's [private vulnerability reporting](https://github.com/jcast90/relay/security/advisories/new) and we'll triage privately before any disclosure. See [`SECURITY.md`](./SECURITY.md) for the full policy.
