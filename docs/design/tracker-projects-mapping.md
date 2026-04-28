# Design: Project/Epic/Task tracker mapping

**Status:** draft — not yet implemented
**Owner:** `@jcast90`
**Target version:** v0.2
**Related:** `src/integrations/tracker.ts`, `src/orchestrator/classifier.ts`, `@aoagents/ao-plugin-tracker-github`, `@aoagents/ao-plugin-tracker-linear`

## Problem

Today Relay has three tracker surfaces:

- **GitHub Issues** (via `ao-plugin-tracker-github`)
- **Linear** (via `ao-plugin-tracker-linear`)
- **Relay native tickets** (`channels/<id>/tickets.json`)

Two gaps:

1. **GitHub Issues is the wrong home for feature work.** In most teams Issues are reserved for bug reports and user-filed requests — using them for internal feature tickets pollutes the bug tracker and creates noise for external contributors.
2. **GitHub Projects v2 is not supported.** That's where most teams that use GitHub actually run their feature planning — kanban/table views, custom fields (Status, Priority, Iteration), and since 2024 native parent-child hierarchy via sub-issues.

We also don't have a coherent way to express **project structure above the channel level**. A channel is "one piece of work"; teams typically want to see many channels rolled up under a project.

## Goals

- Relay channels/tickets can project to GitHub Projects v2, with draft items (not Issues) as the default ticket home.
- Primary repo selection drives the Project name automatically (createOrUpdate semantics, no manual project linking needed).
- Channels map cleanly to an "epic" concept inside the Project.
- Linear supports the same mental model with its native primitives.
- The user can pick a default tracker per workspace and override per-channel.
- Relay native tickets remain the local/offline/self-hosted fallback.

## Non-goals

- Full two-way sync of every external-tracker field. Relay is authoritative for its own channels; external trackers are downstream projections.
- Mirroring draft items back into Relay as separate ticket documents. The ticket row exists once, in Relay; external IDs are foreign keys.
- Supporting GitHub Projects "classic" (deprecated). v2 only.
- Jira, Asana, Notion, Trello. Separate plugins if demand materialises.

## Mental model

User-articulated mapping:

| Relay            | Role                       | GitHub Projects v2                                           | Linear                                                    |
| ---------------- | -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| **Primary repo** | Top-level namespace        | Project (createOrUpdate by name)                             | Team or Project (depending on model — see Linear section) |
| **Channel**      | One piece of work / "epic" | Parent draft item with `Type = Epic`                         | Parent Issue with sub-issues                              |
| **Ticket**       | A task                     | Draft item with `Parent = <channel epic item>`               | Sub-issue under the channel parent                        |
| **Board view**   | Channel's workspace        | Filtered view of the project where `Parent = <channel epic>` | Linear view filtered to the parent                        |

**Why draft items, not repo Issues:** draft items live inside the Project only — they don't appear in the repo's Issues tab, don't generate notifications to issue-watchers, and keep feature planning cleanly separated from bug triage. Teams that want a specific task promoted to a real Issue can do it ad-hoc via the Projects UI (`Convert to issue`) without Relay fighting them.

## Architectural decisions

### Decision 1: Epic-as-parent-draft-item (not epic-as-custom-field)

Two ways to model the channel → epic relationship in GitHub Projects v2:

**Option A — Custom single-select field.** Add a `Epic` field to the project with one option per channel. Each ticket sets `Epic = <channel-name>`. Simple, but:

- GH caps single-select options at ~50 — projects that accumulate many channels over a year hit the wall.
- No actual hierarchy — an "Epic" option is just a label you can sort on.
- Renaming a channel renames the field option, which breaks stored filters on older views.

**Option B — Parent draft item (chosen).** Each channel gets a dedicated draft item of `Type = Epic` in the project. Tickets are draft items with their `Parent` field set to the epic. Uses GitHub's native parent-child hierarchy (launched 2024). Scales, matches how people actually think about it, and custom-field churn stays low.

**We ship Option B as the target.** If edge cases in the `Parent` GraphQL API bite, we fall back to A with a warning in `rly doctor` about the 50-option cap.

### Decision 2: Relay is authoritative; external trackers are projections

- Ticket state lives in `channels/<id>/tickets.json` (and `decisions/`, `feed.jsonl`, etc.).
- External tracker records are **projections** of that state — created and updated by a one-directional sync worker.
- Foreign keys: each ticket row gets an optional `externalIds: { githubProjectItemId?: string; linearIssueId?: string }` map.
- If an external item is edited outside Relay, the next sync tick **overwrites** the drift (with a warning posted to the channel feed). Teams that want editable external trackers can use `rly channel unlink-tracker <id>` to break the projection.

This matches how the Linear integration works today and keeps the mental model simple: Relay is the ticket system; GH Projects / Linear are views onto it.

### Decision 3: createOrUpdate Project per primary repo

- Channel's primary repo alias is the Project name (`relay-core-ui` repo → Project titled "relay-core-ui").
- On first sync:
  1. GraphQL query: `query { user(login: <owner>) { projectsV2(first: 20, query: "<repo>") { nodes { id, title } } } }` to find an existing project with matching title.
  2. If found, reuse; if not, `mutation { createProjectV2(input: { ownerId, title: <repo> }) }`.
  3. Ensure the required custom fields exist (Status, Type, Priority), creating them if missing.
  4. Store `projectId` in `channels/<id>/channel.json` under a new `trackerLinks` object.
- Primary-repo rename → update Project title on next sync. Idempotent.
- Primary-repo change on an existing channel → the old Project is **left alone** (it may host other channels' epics); a new Project is resolved for the new primary repo and the channel's epic is recreated there. Ticket `externalIds` are cleared and re-synced.

### Decision 4: Config shape

Adds a `tracker` block to `~/.relay/config.json`:

```jsonc
{
  "tracker": {
    "default": "github_projects",
    "providers": {
      "github_projects": {
        "owner": "jcast90", // user or org login that hosts the Project
        "project_naming": "per_primary_repo", // or { "fixed": "Work" }
        "epic_model": "parent_draft_item", // or "custom_field"
        "use_draft_items": true, // if false, create real Issues (not recommended)
      },
      "linear": {
        "team_key": "REL", // the 3-letter team prefix
        "project_naming": "per_primary_repo",
      },
      "github_issues": { "enabled": false }, // explicit off — don't mirror tickets as Issues
      "relay_native": { "enabled": true }, // always-on offline fallback
    },
  },
}
```

Per-channel override: `rly channel update <id> --tracker <name>`, stored in `channel.json` as `trackerOverride`.

### Decision 5: Classifier + URL parsing

Today the classifier handles GitHub Issue URLs and Linear URLs/keys. Adds:

- **GH Projects item URL** — `github.com/users/<u>/projects/<n>/views/<v>?pane=issue&itemId=<id>` or the shorter `github.com/orgs/<o>/projects/<n>?itemId=<id>`. Pastes of these become the initial ticket context, with the project/epic/parent resolved from the item's `Parent` field.
- **GH Projects project URL** (no item) — `github.com/users/<u>/projects/<n>`. Initial input "this entire project" interpretation: treat as a request to sync the whole project into a new channel. Rare; maybe just error-out in v0.2.

The existing GitHub Issue URL parsing stays — users who paste an Issue URL still get Issue-backed behaviour, gated on `tracker.providers.github_issues.enabled`.

## Linear parity

Linear doesn't have a "Project" primitive analogous to GH Projects — instead it has **Teams** (orgs) → **Projects** (rollups) → **Issues**. The cleanest mapping:

- Primary repo → Linear **Project** (within the configured team)
- Channel → parent **Issue** in that project (Linear supports sub-issues natively)
- Ticket → sub-issue under the channel parent

This means `rly channel link-linear` (which today just mirrors existing Linear issues onto the channel board) gets augmented with a `linear_create_project` mutation path when the channel is first created under a Linear-default workspace. The existing read-only mirror behaviour stays as `rly channel link-linear <id> <existingProjectId>` for teams that already have a Linear project structure they want to honour.

## Implementation plan

Split into sub-800 LOC PRs per the AGENTS.md rule.

1. **PR A — GraphQL client + createOrUpdate project lifecycle.** New `src/integrations/github-projects/client.ts` with typed mutations. Tested against recorded GraphQL responses + a describe.skip live-network tier.
2. **PR B — Draft item CRUD + custom fields + Status/Type bootstrap.** Handles creating Status/Type/Priority fields on a fresh project. Idempotent.
3. **PR C — Channel → Epic lifecycle.** Wire `channel_create`, `channel_update`, `channel_archive` MCP tools to create/rename/move the epic draft item.
4. **PR D — Ticket ↔ draft-item sync worker.** Ticks every N seconds, reconciles Relay ticket state to GH draft items. Drift detection posts a `status_update` feed entry.
5. **PR E — Classifier + URL parsing for Projects v2 URLs.**
6. **PR F — Linear parity** using the same mapping model (project + parent issue + sub-issues).
7. **PR G — `tracker` config block + `rly channel update --tracker` override + `rly doctor` checks for tracker wiring.**
8. **PR H — Docs + migration note for users coming off the legacy `link-linear`-only flow.**

**Rough effort: 6–7 days focused work, spread across the PR sequence.**

## Open questions

1. **Who owns the Project?** If `tracker.providers.github_projects.owner` is a user (`jcast90`), the project is personal. If an org (`acme`), it's shared. Do we support multi-org setups per-workspace? First cut: single `owner` value per config; teams with multiple orgs can maintain separate `~/.relay/config.json` profiles via `RELAY_CONFIG_HOME`.
2. **What happens when a ticket's channel changes?** If you move a ticket from channel A to channel B, its `Parent` field flips from epic-A to epic-B. Easy. What about history — do we leave a `status_update` in the old channel feed noting the move? Yes, propose yes.
3. **Rate limits.** GH GraphQL has a points-based rate limit (5000/hour for personal tokens, higher for app installations). The sync worker needs throttling when a project grows to hundreds of items. Not a day-1 blocker; flag in `rly doctor`.
4. **Secondary field mapping.** Relay's ticket has `specialty` (`ui | business_logic | …`) — should it project to a custom `Specialty` field on the GH Project? Probably yes, but low priority for v0.2; we can skip in PR B and add in a later PR.
5. **Bulk import.** A user linking an existing repo that already has an active GH Project with hundreds of items — should `rly channel link-github-project` mirror those items into a new channel's ticket list? Probably yes, similar to the existing Linear bulk mirror. Scope for PR D or a separate PR.

## Related work

- `src/integrations/linear-mirror.ts` — existing Linear read-only mirror. New Linear work (PR F) replaces this with a richer bidirectional projection.
- `@aoagents/ao-plugin-tracker-github` — stays as the Issue-side tracker. Projects v2 is a sibling plugin, not a replacement.
- `src/orchestrator/classifier.ts` — URL-parsing entry point. PR E lands here.

## Sign-off criteria for this design doc

Before we write any code, we want:

- [ ] User (@jcast90) confirms the Option B / parent-draft-item choice (vs. custom-field fallback).
- [ ] User confirms Linear parity model (project + parent issue + sub-issues) is right for their workflow.
- [ ] User confirms the config shape or proposes changes.
- [ ] Open question #1 (owner scope) has an answer.

Once those are agreed, we close this doc and start on PR A.
