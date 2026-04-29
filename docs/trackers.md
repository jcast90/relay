# Trackers

Reference for Relay's external tracker integrations: GitHub Projects v2 (v0.2, new) and Linear (v0.1, read-only mirror; richer parity in flight).

> Relay is pre-v1. The tracker integration landed across PRs A–E in the v0.2 milestone. PR G ([#186](https://github.com/jcast90/relay/issues/186)) introduces the `tracker` config block; before it lands the integration uses sensible defaults — see [Setup](#setup).

## Overview

Relay channels and tickets are the source of truth. External trackers — GitHub Projects v2, Linear — are **one-way projections** of that state. The mental model:

| Relay            | Projects v2                                           | Linear (planned, [#185](https://github.com/jcast90/relay/issues/185)) |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| **Channel**      | Parent draft item with `Type = Epic`                  | Parent Issue with sub-issues                                          |
| **Ticket**       | Draft item with `Parent = <channel epic>`             | Sub-issue under the channel parent                                    |
| **Primary repo** | Project (createOrUpdate by repo alias)                | Linear Project (within the configured team)                           |
| **Status**       | `Status` single-select field option                   | Linear status                                                         |
| **Priority**     | `Priority` single-select field option                 | Linear priority                                                       |
| **Type**         | `Type` single-select field option (`Epic` / `Ticket`) | Linear label                                                          |

What Relay projects today (Projects v2):

- **Channels** become epic draft items. Provisioned on first sync via `provisionEpic` in `src/integrations/github-projects/channel-hooks.ts`.
- **Tickets** become draft items, parented to the channel's epic. Created on every sync tick that finds a Relay ticket without an `externalIds.githubProjectItemId`.
- **Title drift** is detected and overwritten — Relay's title wins. A `status_update` warning lands in the channel feed so you see the reconciliation.
- **Type / Status / Priority** custom fields are bootstrapped on first sync (`ensureCustomFields`) and kept in sync from Relay's side. Status field reconciliation specifically is **not yet** covered ([#195](https://github.com/jcast90/relay/issues/195)) — see [Known limitations](#known-limitations).

Direction matters: **Relay → tracker only**. Drift detected on the GitHub side is logged then overwritten on the same tick. Teams that need an editable external board should not link a Relay channel to it (or break the projection — see [Drift behavior](#drift-behavior)).

## Setup

### Token

The integration reuses the existing `GITHUB_TOKEN` env var (also used by the PR watcher and the GitHub issue tracker). Required scopes:

- `project` — read + write Projects v2 items and field values.
- `read:org` — only when the project is owned by an organization. Not needed for personal projects.
- `repo` — already required by the PR watcher; mentioned here for completeness.

A fine-grained personal access token (PAT) with the above scopes works. Classic PATs work too. Both are picked up the same way — `process.env.GITHUB_TOKEN` at the entry boundary, then threaded through the integration via `ProjectsClientDeps` (no `process.env` reads downstream). See [`docs/providers.md`](./providers.md#github-projects-v2-auth) for the auth surface.

### Config (PR G, in flight)

PR G ([#186](https://github.com/jcast90/relay/issues/186)) lands a `tracker` block in `~/.relay/config.json`:

```jsonc
{
  "tracker": {
    "default": "github_projects",
    "providers": {
      "github_projects": {
        "owner": "jcast90", // user or org login
        "project_naming": "per_primary_repo", // or { "fixed": "Work" }
        "epic_model": "parent_draft_item",
        "use_draft_items": true,
        "sync_min_rate_limit_budget": 200, // see Rate limits below
      },
      "linear": {
        "team_key": "REL",
        "project_naming": "per_primary_repo",
      },
      "github_issues": { "enabled": false }, // explicit off
      "relay_native": { "enabled": true }, // always-on offline fallback
    },
  },
}
```

Until PR G ships, the integration runs on these defaults: owner inferred from the `GITHUB_TOKEN` user, `project_naming = per_primary_repo`, `epic_model = parent_draft_item`, `use_draft_items = true`, sync budget = 200. Per-channel override via `rly channel update <id> --tracker <name>` lands with PR G as well.

## GitHub Projects v2 mapping

### Field mapping

```
Relay channel                        GitHub Projects v2
────────────────                     ───────────────────
channelId                            (not stored externally)
name                          ──►    epic draft item title
description                   ──►    epic draft item body
trackerLinks.githubProjects.*        (foreign keys back into the project)
  projectId                          PVT_… node id
  projectNumber                      integer in the URL
  projectUrl                         full URL
  epicItemId                         PVTI_… (item id — used for field updates / archival)
  epicDraftIssueId                   DI_…   (draft-issue id — used for title/body edits)

Relay ticket                         draft item under the epic
────────────                         ─────────────────────────
ticketId                             (not stored externally)
title                         ──►    draft item title
description                   ──►    draft item body
status                        ──►    Status single-select option
priority                      ──►    Priority single-select option
specialty                            (not yet projected — backlog)
externalIds.githubProjectItemId      PVTI_…
externalIds.githubDraftIssueId       DI_…
```

The two id types matter — see the contract notes in `src/integrations/github-projects/draft-items.ts`. `itemId` is what you pass to field-update mutations and `archiveProjectV2Item`; `draftIssueId` is what you pass to title/body mutations.

### Status field options

The first sync tick provisions a `Status` single-select field if the project doesn't have one already, with these options:

- `Pending`
- `Blocked`
- `Ready`
- `Executing`
- `Verifying`
- `Retry`
- `Completed`
- `Failed`

These mirror Relay's ticket lifecycle (see the README's "Tickets" section). If a project already has a customized `Status` field with different option names, Relay logs a warning to the channel feed and falls back to leaving the field unset on its draft items — see [Troubleshooting](#troubleshooting). Full Status reconciliation is tracked under [#195](https://github.com/jcast90/relay/issues/195).

### Project resolution

Per the design doc (`docs/design/tracker-projects-mapping.md` § Decision 3), the project name defaults to the channel's primary repo alias. First sync runs:

1. GraphQL search for an existing Projects v2 owned by the configured `owner` with title matching the primary repo alias.
2. If none, create one (`createProjectV2`).
3. Bootstrap `Type` / `Status` / `Priority` custom fields if missing (`ensureCustomFields`, idempotent).
4. Create the channel epic draft item; persist `epicItemId` + `epicDraftIssueId` onto `channel.json`.

All four steps are idempotent on re-run; the only non-idempotent operation is the epic draft-item create, which is gated by the `trackerLinks.githubProjects` check on the channel.

## Linear

Today's Linear surface is the read-only mirror in `src/integrations/linear-mirror.ts` plus the CLI bindings (`rly channel link-linear`, `rly channel linear-sync`). It mirrors existing Linear issues onto a channel's ticket board for context but does not project Relay tickets back to Linear.

Full Linear parity — channel → parent issue → sub-issues, with the same Relay-authoritative drift behavior as GitHub Projects v2 — lands in PR F ([#185](https://github.com/jcast90/relay/issues/185)). Until it ships, existing `rly channel link-linear` users keep working unchanged: the read-only mirror does not interact with the v0.2 GitHub Projects v2 plumbing.

## Drift behavior

Relay's sync worker is a one-shot reconciliation tick (`runSyncTick` in `src/integrations/github-projects/sync-worker.ts`). On every tick it:

1. Reads the channel's tickets from `channels/<id>/tickets.json`.
2. For each ticket without `externalIds.githubProjectItemId`, creates a new draft item under the channel epic.
3. For each ticket _with_ `externalIds`, fetches the GitHub draft item and compares titles. Mismatch → overwrite GitHub with Relay's title and emit a `DriftEvent` of kind `title-changed`.
4. Logs throttle / rate-limit telemetry on every tick (`SyncTickResult.rateLimit`).

What you'll see in the channel feed when a drift overwrite happens:

```
status_update
  Tracker drift overwritten — ticket T-3
  observed: "Add rate limiter (manual edit)"
  applied:  "Add rate-limiter middleware"
```

The `observed` value is whatever was in the GitHub UI before the tick; `applied` is what Relay rewrote it to. If the user wanted to keep the GitHub-side edit, they need to either:

- Edit the title in Relay (the source of truth — channel feed, ticket board, or the `rly channel post` ticket commands), so the next sync no-ops; or
- **Break the projection** entirely. PR G ([#186](https://github.com/jcast90/relay/issues/186)) ships `rly channel unlink-tracker <id>` for this. Until it lands, the workaround is to manually delete the `trackerLinks.githubProjects` block from `channels/<id>/channel.json` and the `externalIds` map from each ticket — the next sync tick will treat the channel as un-projected and skip.

Drift is by design. Relay is built around an audit trail; one-way projection keeps the audit trail authoritative without forcing the GitHub UI into read-only mode.

## Rate limits

GitHub's GraphQL API has a points-based rate limit (5000 points/hour for personal tokens; higher for app installations). The sync worker tracks remaining budget and refuses to start new work on a tick when the remaining budget drops below a threshold:

- **Default threshold: 200 points.** Conservative — leaves headroom for ad-hoc CLI invocations during reconciliation.
- **Tunable per-call** via `SyncTickInput.minRateLimitBudget`. Pass `0` to disable throttling (sane only in tests).
- **Tunable globally** via `tracker.providers.github_projects.sync_min_rate_limit_budget` once PR G ([#186](https://github.com/jcast90/relay/issues/186)) lands.

A throttled tick returns `{ throttled: true, ... }` and emits a feed entry. The next tick re-evaluates the budget and resumes once headroom returns.

The scheduler timer (the loop driver that fires `runSyncTick` on an interval) is **not yet wired** in v0.2 — see [Known limitations](#known-limitations). Until it lands, syncs run on demand: when a channel-create / channel-update MCP tool fires, when the user pastes a Projects URL, or when the loop driver lands ([#194](https://github.com/jcast90/relay/issues/194)).

## Troubleshooting

| Symptom                                                         | Likely cause / fix                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `403 Resource not accessible by personal access token`          | Token missing `project` scope (or `read:org` for org-owned projects). Add the scope and try again. Personal vs. fine-grained PATs both work.                                                                                                                                                                                                                                   |
| Sync silently no-ops on a brand-new channel                     | Channel has no `trackerLinks.githubProjects` block. Provisioning runs on channel-create or on the first URL paste — verify one of those happened. Until PR G's MCP-handler wiring ([#193](https://github.com/jcast90/relay/issues/193)) lands, manual provision is via the channel-hooks API.                                                                                  |
| Status field never updates on the GitHub board                  | Project has a customized `Status` field with non-default option names. Relay falls back to leaving the field unset rather than guessing. Tracking issue: [#195](https://github.com/jcast90/relay/issues/195). Workaround: rename your options to match Relay's lifecycle (Pending / Blocked / Ready / Executing / Verifying / Retry / Completed / Failed) or wait for the fix. |
| `staleIdCleared` events appear in the sync result               | A draft item Relay knew about was deleted out from under us in the GitHub UI. The integration clears the stale `externalIds` on that ticket so the next tick re-projects from scratch. Expected, not an error.                                                                                                                                                                 |
| `throttled: true` returned on a tick                            | GraphQL rate-limit budget dropped below the configured threshold (default 200). Wait for the hourly window to reset, or tune `minRateLimitBudget` lower. Frequent throttling on a single project usually means too many tickets in too short a window — open a tracking issue.                                                                                                 |
| Drift overwrite warning floods the channel feed                 | Someone is editing the GitHub board manually while the sync worker runs. Either stop the manual edits, or break the projection. See [Drift behavior](#drift-behavior).                                                                                                                                                                                                         |
| Pasted Projects URL classifier "doesn't recognize" the URL      | URL isn't under `github.com/(users\|orgs)/.../projects/<n>`. The parser intentionally rejects malformed item ids and any non-Projects-v2 GitHub URL — paste the URL straight from your browser address bar.                                                                                                                                                                    |
| Pasted Projects **project-only** URL (no item) returns an error | v0.2 deferred the project-only paste case (per design Decision 5). Workaround: paste a specific item URL.                                                                                                                                                                                                                                                                      |

## Known limitations

The v0.2 PR sequence lands the core integration in pieces. These items are explicitly **not** in v0.2 and have tracking issues:

- **Status-field drift not yet reconciled** — title drift is detected and overwritten; `Status` field drift is not. Full coverage requires per-project option-id resolution. Tracking: [#195](https://github.com/jcast90/relay/issues/195).
- **Bulk import not wired** — linking an existing GH Project with hundreds of items into a fresh Relay channel does not pull those items into the ticket list. Tracking: [#196](https://github.com/jcast90/relay/issues/196).
- **MCP-handler wiring pending** — `channel_create` / `channel_update` / `channel_archive` MCP tools do not yet invoke the channel-hooks orchestration. The orchestration primitives are in tree (`src/integrations/github-projects/channel-hooks.ts`); only the wiring is deferred to keep PR C bounded. Tracking: [#193](https://github.com/jcast90/relay/issues/193).
- **Scheduler timer pending** — `runSyncTick` is a one-shot. The interval loop driver lands behind the `tracker` config block so it can be feature-flagged. Tracking: [#194](https://github.com/jcast90/relay/issues/194).
- **Linear parity** — see the [Linear](#linear) section. Existing read-only mirror keeps working. Tracking: [#185](https://github.com/jcast90/relay/issues/185).

## Migration

**No migration concern in v0.2.** Relay had no production users with linked external trackers before v0.2 — the GitHub Projects v2 integration is greenfield. The pre-existing `linear-mirror.ts` read-only flow (`rly channel link-linear`, `rly channel linear-sync`) keeps working unchanged until PR F ([#185](https://github.com/jcast90/relay/issues/185)) replaces it with full bidirectional projection.

If you're reading this in a future where v0.2 is no longer recent and wondering why there's no migration script: there was nothing to migrate. The `tracker` config block, the `trackerLinks` channel field, and the `externalIds` ticket field were all introduced together in v0.2 and have been optional / back-compat from day one — a channel without `trackerLinks` is just an un-projected channel and the sync worker no-ops on it.

## Related

- Design doc: [`docs/design/tracker-projects-mapping.md`](./design/tracker-projects-mapping.md) — full rationale, alternatives considered, sign-off criteria.
- Source map (v0.2 PRs A–E):
  - `src/integrations/github-projects/client.ts` — GraphQL client + project resolver (PR A, [#188](https://github.com/jcast90/relay/issues/188))
  - `src/integrations/github-projects/draft-items.ts`, `fields.ts` — draft-item CRUD + custom field bootstrap (PR B, [#189](https://github.com/jcast90/relay/issues/189))
  - `src/integrations/github-projects/channel-hooks.ts` — channel ↔ epic orchestration (PR C, [#191](https://github.com/jcast90/relay/issues/191))
  - `src/integrations/github-projects/sync-worker.ts` — one-shot reconciliation tick + drift detection (PR D, [#192](https://github.com/jcast90/relay/issues/192))
  - `src/integrations/github-projects/url-parser.ts` — Projects v2 URL parsing in the classifier (PR E, [#190](https://github.com/jcast90/relay/issues/190))
- README: [Integrations § GitHub Projects v2](../README.md#github-projects-v2-v02-new)
- Getting started: [Linking a channel to GitHub Projects v2](./getting-started.md#linking-a-channel-to-github-projects-v2)
- Auth: [Providers § GitHub Projects v2 auth](./providers.md#github-projects-v2-auth)
