# Spike: Evaluate OpenSpec for `/plan` phase artifacts

**Status:** spike — recommendation, not implementation
**Owner:** `@jcast90`
**Tracks:** #204
**Related code:** `src/domain/phase-plan.ts`, `src/domain/ticket.ts`, `src/domain/channel.ts`, `src/integrations/github-projects/`, `docs/design/tracker-projects-mapping.md`

## Recommendation

**Pass on adopting the OpenSpec toolchain. Steal one idea: the `specs/` artifact.**

Three of OpenSpec's four artifacts already have a stronger native equivalent in Relay, and adopting the full structure would create parallel sources of truth for things the v0.7.0 tracker work just unified. The piece worth borrowing is `specs/` (requirements + scenarios), because nothing in Relay currently captures that shape.

## Mapping: OpenSpec → Relay

| OpenSpec artifact                               | Relay equivalent                                                                                                                     | Verdict                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposal.md` (why + what's changing)           | Channel description + design-doc header (`Problem` / `Goals` / `Non-goals` per `tracker-projects-mapping.md:8-37`)                   | **Duplicate.** Use the existing design-doc header.                                                                                                                                            |
| `design.md` (technical approach)                | `docs/design/<feature>.md` with established sections (Mental model, ADRs, Implementation plan)                                       | **Duplicate.** Convention exists; one example shipped (`tracker-projects-mapping.md`).                                                                                                        |
| `tasks.md` (implementation checklist)           | `TicketLedgerEntry` (`src/domain/ticket.ts:58`) → `channels/<id>/tickets.json` → GitHub Projects v2 draft items via `sync-worker.ts` | **Duplicate, and Relay's shape is richer** — tickets carry `acceptanceCriteria`, `specialty`, `dependsOn`, `status`, plus external-tracker foreign keys. A markdown checklist is a downgrade. |
| `specs/` (requirements + scenarios)             | _No equivalent._                                                                                                                     | **Adopt the idea, not the toolchain.**                                                                                                                                                        |
| `openspec/changes/<name>/` folder               | Channel (`src/domain/channel.ts:96`) — `channelId` + `name` + `tier` + `repoAssignments[]`                                           | **Channel already is this**, with the additional benefit that it projects to GH Projects v2 as an Epic draft item per `tracker-projects-mapping.md:42-50`.                                    |
| `/opsx:propose`, `/opsx:apply`, `/opsx:archive` | `/plan` (emits `PhasePlan` + `TicketPlan`), phase ledger lifecycle (`src/domain/run.ts:6` 14-state FSM), channel archive             | **Duplicate state machine.** Relay's is formal; OpenSpec's is convention.                                                                                                                     |

The four-artifact, per-change-folder model in OpenSpec is essentially what Relay built into the channel + ticket ledger + design-doc folder, and v0.7.0 wired the channel half through to GitHub Projects v2 as a one-way projection.

## Open questions, answered

**1. Fit vs Relay's existing planning surface.** Heavier ceremony than chat-first flow wants. Relay already produces a `PhasePlan` (`phase-plan.ts:22`) and decomposes it into a `TicketPlan` written to `ticketLedger.json` and reflected to channel state. Adding a markdown-file workflow on top would mean every `/plan` turn produces both a structured object _and_ four markdown files — twice the surface, twice the drift risk.

**2. Artifact lifecycle.** No good answer. OpenSpec assumes change folders are committed in-tree (`openspec/changes/...`). Relay's plans are user state, not repo state — they live in `~/.relay/artifacts/<runId>/` and channel stores. Committing them muddies the boundary. Storing them in channel state defeats OpenSpec's "specs in your repo" pitch.

**3. Tracker overlap.** `tasks.md` directly duplicates the v0.7.0 ticket → draft-item sync. Adopting OpenSpec would mean either ignoring `tasks.md` (defeating the point) or running a second projection from `tasks.md` checkboxes → tickets → draft items, which is three sources of truth for the same list. Hard pass.

**4. Model routing (cost tiers).** OpenSpec generates four artifacts per proposal — bigger output than today's `PhasePlan`. Under #200's role table this is `plan` role, which means Opus on Performance and Sonnet on Balanced. Affordable, but the marginal cost only pays off if the artifacts are load-bearing. Per the duplication above, three of them aren't.

**5. Adapter scope.** Mirror nothing. Fold any borrowed value into existing surfaces.

## What to actually build (follow-up, sized S)

One narrow ticket: **add an optional `specs/` block to the design-doc convention and let `/plan` populate it.**

- Extend `docs/design/<feature>.md` with a `## Specs` section, or a sibling `docs/design/<feature>/specs/` folder when the feature is large enough to warrant scenario files.
- Schema: bullet list of requirements, each with one or more scenario blocks (`Given … When … Then …`).
- `/plan` emits this section alongside the existing `PhasePlan` when classifier tier is `feature_large` or `feature`. Skip for `bugfix`/`chore`.
- No new state machine, no new folder tree, no slash commands.

This captures the only OpenSpec idea that doesn't already exist in Relay, costs a small docs + prompt change, and creates zero new sources of truth.

## Sign-off

Recommendation: **pass on OpenSpec adoption; open a sized-S follow-up for the `specs/` block on design docs.** Close #204 with a link to this doc.
