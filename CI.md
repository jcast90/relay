# CI tiers

Relay's CI runs in two tiers. Both live under `.github/workflows/`.

## Tier 1 — fast PR CI (`ci.yml`)

Runs on every `push` to `main` and every `pull_request`. Scripted-mode only.
Finishes in under a minute on a cold cache.

Jobs:

- `ts-verify` — `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`, GUI Vite build.
- `rust-check` — `cargo check --workspace --locked` + `cargo test -p harness-data`.
- `format-check` — Prettier check (advisory, `continue-on-error: true`).

`pnpm test` runs with `HARNESS_LIVE` unset, so the orchestrator uses
`ScriptedInvoker` and integration suites gated on env flags stay skipped.
This is the deterministic path reviewers see on every PR.

## Tier 2 — integration (`integration.yml`)

Runs the suites that are `describe.skip`'d in the fast tier because they
need external services. Two triggers:

- **Nightly** — cron `0 6 * * *` (06:00 UTC).
- **On-demand** — `workflow_dispatch` from the Actions UI. Pass `suites`
  (one of `all|postgres|git|pr-watcher`) to run just one tier.

### Jobs and what they need

| Job                        | Unskip flag                      | External service              | Secret required                                      |
| -------------------------- | -------------------------------- | ----------------------------- | ---------------------------------------------------- |
| `postgres-integration`     | `HARNESS_TEST_POSTGRES_URL`      | Postgres 16 service container | none — provisioned inline                            |
| `git-worktree-integration` | `RELAY_TEST_REAL_GIT=1`          | system `git`                  | none                                                 |
| `pr-watcher-live`          | `GITHUB_TOKEN`, `HARNESS_LIVE=1` | github.com                    | `INTEGRATION_GITHUB_TOKEN` (fine-grained read token) |

Jobs whose secret isn't set print a skip notice and exit 0 — the workflow
stays green until an admin provisions them. Grep the workflow file for
`Skip —` to find the exact message.

### Secrets an admin needs to add

To light up the full matrix, add these under `Settings -> Secrets and
variables -> Actions`:

- `INTEGRATION_GITHUB_TOKEN` — fine-grained PAT with **read** access to the
  pr-watcher fixture repo. No write scope. Currently the `describe.skip`
  block in `test/cli/pr-watcher-factory.test.ts` is empty — this secret is
  the slot it'll consume once the live-network cases land.

Until that's added, `pr-watcher-live` reports "skipped" in the Actions UI.
`postgres-integration` and `git-worktree-integration` run unconditionally.

## Running the integration tier locally

The unskip flags in the table above are the whole interface — no CI magic.
Examples:

```bash
# Postgres store + migrations
HARNESS_TEST_POSTGRES_URL=postgres://postgres@localhost:5432/relay_test pnpm test test/storage

# Real-git worktree sandbox
RELAY_TEST_REAL_GIT=1 pnpm test test/execution/git-worktree-sandbox.test.ts
```

Scripted mode stays the default. Don't flip `HARNESS_LIVE` in PRs unless
you're specifically debugging adapter plumbing.
