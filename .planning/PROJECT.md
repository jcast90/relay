# Relay

## What This Is

Relay is a local-first agent harness for cross-repo coordination. One orchestrator agent — running inside the user's normal Claude or Codex CLI — reaches into the user's other repos, talks to live agents there, and delegates work down a tree. State (channels, tickets, decisions, crosslink messages) lives in `~/.relay/` on the user's machine. Built for individual developers and small teams who own work across multiple codebases (UI + backend + ML + SDK) where single-repo harnesses force them to babysit three uncorrelated chat sessions.

## Core Value

**Cross-repo agent-to-agent delegation in a single delegation tree.** One orchestrator the user talks to, reaching into every repo they own, dispatching to live repo-admin agents that can spin up their own sub-teams. If everything else fails — dashboards, audit trail, integrations — this primitive must still work, because nothing else in the product is differentiated without it.

## Requirements

### Validated

Inferred from shipped behaviour (`git log`, `ROADMAP.md` Phase 1-3, README pitch, v0.2 release).

- ✓ **Multi-repo session discovery + crosslink messaging** — sessions in different repos find each other through MCP crosslink tools and exchange messages directly. — pre-GSD-init era
- ✓ **Ticket DAG with `assignedAlias` routing** — one plan, multiple ticket streams across repos, scheduled in dependency order. — pre-GSD-init era
- ✓ **Decision log with rationale + alternatives** — every cross-repo decision routed through Relay produces an auditable record. — pre-GSD-init era
- ✓ **Three dashboards, one source of truth** — CLI (`rly`), ratatui TUI, Tauri desktop GUI all read the same `~/.relay/` files. No sync layer. — pre-GSD-init era
- ✓ **Multi-provider dispatch** — Claude and Codex CLI adapters both supported end-to-end. — pre-GSD-init era
- ✓ **GitHub Projects v2 integration (v0.2)** — channels project to GH Projects v2 boards; drift detected and overwritten; URL-paste classifier creates tickets. — v0.7.0 (#199)
- ✓ **Autonomous mode with budget caps + STOP-file kill switch** — bounded by wall-clock, token budget, and a file-based abort. — pre-GSD-init era
- ✓ **`rly install` + drift manifest** — one-command install with TUI/GUI startup nudge when the installed bits drift from the running version. — pre-GSD-init era
- ✓ **Per-session token-usage telemetry + context-window bar** — TUI / GUI / CLI all surface live `% of context window consumed`; threshold events at 75/90/95% land on the channel feed. — Phase 1 (#218→#228, 2026-05-10)
- ✓ **`rly handoff` brief synthesizer + 90% nudge** — departing agent authors gap-fill section; new session seeded with structured brief from `~/.relay/` artifacts. — Phase 2 (#219→#226, 2026-05-10)
- ✓ **Repo-admin readiness handshake (`agent_ready`)** — explicit boot-readiness signal distinct from heartbeat liveness, exposed via `harness-data` to dashboards. — Phase 3 (#216, 2026-05-09; SUMMARY merged #221, 2026-05-11)

### Active

Building toward these in the current milestone.

- [ ] **Project readiness surface** — single honest view per project across in-session hook injection + TUI + GUI + CLI, reading the same state from `~/.relay/`. (Roadmap Phase 4.)
- [ ] **Per-task worker tier (`spawn_worker`)** — replace `spawnWorkerStub`; repo-admins dispatch ephemeral workers into isolated worktrees, reusing the readiness primitive. (Roadmap Phase 5, AL-14.)
- [ ] **Chat-first workflow surface** — `agent-harness claude` (chat) is the primary entry point; the linear `run "<feature>"` pipeline is secondary. Projects group chats; chats produce plans; plans dispatch. Not yet a roadmap phase — see Strategic Directions.

### Out of Scope

Explicit boundaries. Each carries reasoning so they don't get re-added accidentally.

- **Hosted SaaS / cloud service** — Relay is local-first by design. All state in `~/.relay/`. No hosted backend, no sync server, no multi-tenant data plane. Federation (see Strategic Directions, L6) is the only sanctioned remote surface and is opt-in.
- **Single-repo orchestration features** — if a feature only matters inside one repo and doesn't compose with the delegation tree, it doesn't belong in Relay. Single-repo agent loops already exist (Claude Code, Codex CLI standalone, Cursor) and are not what users come to Relay for.

## Context

- **Brownfield project.** Relay predates GSD initialization by months. Active development since at least 2026-04 (v0.2 + tracker work, autonomous mode, install command). The `.planning/` directory was added 2026-05-09 (#216) to formalize Phases 1-3 of the trust-and-visibility stack. This PROJECT.md is being written 2026-05-11 to lock the north star before Phases 4-5.
- **Stack.** TypeScript orchestrator (CLI + MCP server + pipeline) ⊕ Rust ratatui TUI ⊕ Tauri desktop GUI (React + Vite frontend, Rust backend) ⊕ shared Rust crate `crates/harness-data/` ⊕ shared Rust crate `crates/relay-paths/` (hoisted in Phase 1 PR-3). Three dashboards never talk to each other — they read the same files on disk.
- **Test discipline.** Vitest + cargo. Scripted mode (`ScriptedInvoker`) is the default; live-network tests sit inside `describe.skip(...)`. No snapshot tests for orchestrator output. Two CI tiers: fast scripted on every PR, integration nightly.
- **PR hygiene.** Sub-800 LOC PRs, one logical change per PR, no drive-by reformats. Phases 1-3 each shipped as 5 PRs in 24-48h windows.
- **Strategic context.** The user has already framed the monetization split (L0-L5 OSS, L6 closed federation) in `.claude` memory and the chat-first workflow as the intended UX. Neither is on ROADMAP.md yet; see Strategic Directions.

## Constraints

- **Tech stack**: TypeScript (orchestrator + CLI), Rust (TUI + GUI backend + shared crates), React + Vite (GUI frontend), Tauri (GUI shell). — set pre-GSD-init; switching any of these is a pivot, not a refactor.
- **State location**: everything under `~/.relay/` on the user's machine. — local-first is the product. Cloud storage backends are not on the table.
- **Provider surface**: Claude and Codex CLI today. — multi-provider is open; abstractions exist; adding Cursor / Aider / Continue is allowed but not committed.
- **PR size**: sub-800 LOC per PR; one logical change. — enforced in AGENTS.md; phases split into 4-5 PRs accordingly.
- **Test mode**: scripted-by-default; `HARNESS_LIVE=1` only for adapter plumbing. — keeps PR CI fast and deterministic.
- **Dependencies**: Phase 4 depends on Phase 3 readiness primitive (without it the surface conflates alive with ready and lies to users); Phase 5 depends on Phase 3; Phase 5 helped-but-not-blocked by Phase 4.

## Strategic Directions

Non-binding directions that shape design choices but aren't yet roadmap phases. Promoted to Active when the time comes.

- **L0-L6 learning layer (monetization).** Scoped 2026-04-23. Ship L0-L5 fully open source; reserve L6 (federated cross-user population priors + hosted aggregator) as the closed paid tier. Single-provider versions of L0-L5 are likely within 12-18 months from Anthropic / OpenAI / Cursor; the cross-provider federated layer is structurally unavailable to them, which is the durable moat. **Design implication for current phases:** when designing `trajectories.jsonl` (L0), include optional `federation: { opt_in: bool, user_token: string }` from day one so retrofitting isn't required later. Do not leak federation-layer logic into the OSS repo.
- **Chat-first workflow shape.** The intended user flow is Project → Chat (interactive session, talk to Atlas-style planning agent) → Plan (emerges collaboratively) → Dispatch (kicks off implementer / reviewer / tester agents). `agent-harness claude` is the primary entry point, not `agent-harness run`. Phases 1-5 are plumbing underneath this UX; Phase 4 (project readiness surface) is the closest current phase to the destination, but the chat-first surface itself is a future phase. Implication: dashboards, channels, and project structure should orient around chat-first.
- **Multi-provider neutrality.** Claude and Codex shipped; Cursor / Aider / Continue / future providers are open territory. Provider abstractions (adapter layer in `src/agents/`) already exist. Federation (L6) depends on cross-provider neutrality being real.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Local-first, no hosted SaaS | All state in `~/.relay/`. No telemetry, no sync layer. Three dashboards read same files. Avoids cloud-ops surface and lock-in. | ✓ Good — pre-GSD-init |
| Cross-repo delegation as the differentiator | Single-repo harnesses don't compose; Relay's value is the tree. Phases 1-5 all serve this. | ✓ Good — informs Phase 4/5 sequencing |
| Two-tier architecture (repo-admin persistent, workers ephemeral) | Admins coordinate / track state; workers execute in isolated worktrees and report up. AL-14 (`spawn_worker`) finishes this tier. | — Pending (workers land in Phase 5) |
| GSD planning directory adopted mid-flight | Adopted 2026-05-09 for Phases 1-3 trust stack; predates this PROJECT.md by 2 days. Brownfield-flavoured `.planning/`. | — Pending (this PROJECT.md is the formalization) |
| L0-L5 OSS / L6 closed federation as monetization split | OSS adoption maximizes population-prior value; federation is the structural moat single providers can't build. | — Pending (no learning-layer phase yet) |
| Phase 1 telemetry feeds Phase 2 handoff via channel-feed threshold events | One channel, typed metadata, schemaVersion: 1. Phase 2 PR-3 subscribed and is live. | ✓ Good — contract bidirectional |
| Phase 3 readiness ≠ heartbeat | Heartbeat says process alive; readiness says agent finished onboarding. Conflating them ships a dashboard that lies. | ✓ Good — primitive in place, Phase 4 consumes it |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
5. Audit Strategic Directions — any ready to promote to Active?

---
*Last updated: 2026-05-11 after initialization (brownfield, mid-flight; formalizing north star before Phase 4 planning).*
