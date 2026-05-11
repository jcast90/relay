# Phase 4: Project readiness surface - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `04-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-05-11
**Phase:** 04-project-readiness-surface
**Areas discussed:** Project entity formalization, SessionStart hook content shape + diff vs snapshot, Four-state visual representation

---

## Gray-area selection

User picked 3 of 4 surfaced gray areas to discuss. The fourth (Codex hook parity) was deferred to the researcher.

| Option | Description | Selected |
|---|---|---|
| "Project" entity formalization | Channel-rooted vs new top-level Project vs implicit-from-cwd | ✓ |
| SessionStart hook content shape + diff vs snapshot | Density + diff/snapshot composition | ✓ |
| Codex hook parity | Ship Claude-only / build Codex equivalent / block on spike | (deferred to researcher) |
| Four-state visual representation | Single canonical scheme vs per-surface aliases vs symbols-only | ✓ |

A fifth ROADMAP open question — `rly project show` CLI shape — was also deferred (this time to the planner).

---

## Area 1 — "Project" entity formalization

| Option | Description | Selected |
|---|---|---|
| Channel IS the project | No new entity. TUI/GUI top-level lists channels; drill-in shows repos × admin × feed. Hook resolves channel via cwd → repoAssignments or RELAY_CHANNEL_ID env. | ✓ |
| New Project entity above channels | `src/domain/project.ts` with `{ projectId, name, channelIds[] }`. Adds a layer; unlocks long-running multi-channel projects. | |
| Implicit project = cwd | Hook + CLI infer "project" from cwd: this repo + every other repo in channels this repo is in. Ambiguous when repo is in N channels. | |
| Defer — ship without a top-level concept | Phase 4 renders channels and repos directly with no "project" framing in the UI. | |

**User's choice:** Channel IS the project.
**Notes:** User picked the recommended option with the preview ASCII mockup. Maps directly to D-01 in CONTEXT.md. The TUI preview showed two channels at top-level with per-repo state + feed counts inline.

---

## Area 2 — SessionStart hook content density

| Option | Description | Selected |
|---|---|---|
| Terse one-liner per repo | ~5-15 lines total for a typical 3-repo channel. Compact, scannable. Easy to enrich later. | ✓ |
| Structured multi-section markdown | ~30-60 lines. Per-repo subsection with state + decisions + open tickets. Rich but burns 2-4% of 200k context. | |
| Adaptive: terse on resume, rich on cold start | Detect cold vs warm; switch density. Smart but adds detection complexity. | |
| Just channel + state lines, no feed digest | Lowest token cost. No "since last time" hint at all. | |

**User's choice:** Terse one-liner per repo.
**Notes:** Sample shape (from the option preview) became D-03's canonical hook output sample:
```
[Relay] Channel: oauth-rollout (3 repos)
  ● ui-repo       ready (admin: atlas-7f2)
  ● backend-repo  ready (admin: atlas-3a1)
  ○ sdk-repo      booting (since 2m ago)
Feed: 4 new entries since you were last here. Use rly status for detail.
```

---

## Area 2 — SessionStart hook diff vs snapshot

| Option | Description | Selected |
|---|---|---|
| Snapshot only | Inject current state every time. No diff machinery. Cleanest contract; agent/user can ask "what changed" via MCP. | ✓ |
| Snapshot + unread-feed-events count only | Snapshot + "N new feed events since last turn." Requires per-session lastSeen watermark. | |
| Snapshot + structured diff section | "Since you were last here" with state transitions, new tickets, merged PRs. Highest cost + failure modes. | |

**User's choice:** Snapshot only.
**Notes:** Maps to D-04 (snapshot only) and D-05 (no structured diff). The "Feed: N new entries" count tail from the chosen Area 2 density option is presentation only — driven by feed.jsonl length minus a per-session watermark. Watermark persistence shape deferred to planner (see Claude's Discretion in CONTEXT.md).

---

## Area 3 — State scheme

| Option | Description | Selected |
|---|---|---|
| Single canonical scheme | One enum `disconnected \| booting \| ready \| stale`. Same word in hook, rly status, TUI, GUI. Symbols/colors are presentation layer. | ✓ |
| Canonical scheme + per-surface aliases | Same enum underneath but each surface picks its own label. Risk of drift. | |
| Symbols only, no shared strings | Each surface picks symbols. No canonical string. Agents can't reliably parse. | |

**User's choice:** Single canonical scheme.
**Notes:** Preview showed four renderings of the same canonical `booting` state:
```
Hook:       ○ sdk-repo  booting
rly status: sdk-repo  state=booting
TUI col:    sdk-repo  [BOOTING]
GUI badge:  sdk-repo  [🟡 booting]
```
Maps to D-06 in CONTEXT.md.

---

## Area 3 — Ready visual emphasis

| Option | Description | Selected |
|---|---|---|
| Muted ready, emphasized exceptions | `ready` is the expected baseline — plain text. `booting` gets warning color/symbol; `stale` gets error. Eye drawn to attention-needed states. | ✓ |
| Green-light all healthy states | Traffic-light metaphor. `ready` = green/bold; `booting` = yellow; `stale` = red. | |
| Defer to research/planner | User has no strong preference; trust planner's surface-level color choices as long as canonical scheme is consistent. | |

**User's choice:** Muted ready, emphasized exceptions.
**Notes:** Maps to D-07 in CONTEXT.md. Applies to TUI + GUI; CLI may add ANSI color via a `RLY_COLOR` env (planner's call — listed under Claude's Discretion).

---

## Claude's Discretion

Items the user explicitly left to downstream agents:

- **Codex hook surface** (researcher) — investigate Codex CLI hook mechanism; propose parity wrapper, per-launch injection, or documented gap.
- **`rly project show` CLI shape** (planner) — extend `rly status`, add `rly channel show <channelId>`, or `rly project show <channelId|name>` alias.
- **`lastSeenFeedIdx` persistence shape** (planner) — sibling file on CrosslinkSession, separate file, or drop the feature.
- **State enum final naming** (planner) — `disconnected | booting | ready | stale` or alternative wording; coordinate with `src/lifecycle/session-lifecycle.ts` to avoid lexical collisions.
- **TUI/GUI navigation depth + cmux pane references** (planner) — whether cmux refs land in Phase 4 or follow-up.

## Deferred Ideas

See CONTEXT.md `<deferred>` section for the full list. Highlights:

- Top-level Relay Project entity (rejected for Phase 4; reconsider when channels grow to 10+ per umbrella).
- Structured diff in hook output (rejected for Phase 4; reconsider with shipped-product evidence).
- Multi-channel hook output (Phase 5+ concern).
- Worker state rendering (Phase 5 / AL-14 — schema reserves `readyKind: "worker"` already).
