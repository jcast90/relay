---
title: Handoff feature design decisions
date: 2026-05-09
context: Cross-provider session handoff for when user runs out of credits/tokens with one provider and wants to switch to another (e.g. Claude → Codex) without losing context.
---

# Handoff feature design

## Problem

When a user exhausts credits/tokens with one provider mid-task and wants to switch to another, getting the new agent caught up is painful. Replaying the raw transcript is wasteful; manual summaries are inconsistent. Relay already persists rich state in `~/.relay/` (channel feeds, decision logs with rationale + alternatives, ticket DAGs, file-touch history) — that's exactly the corpus a handoff brief should be built from.

Same machinery also serves the "resumed after a week" case (laptop closed, come back to a fresh session in the same provider).

## Decisions

### 1. Brief source: hybrid (artifacts + agent-authored gaps)

The handoff brief is assembled in two parts:

- **Deterministic skeleton from artifacts.** Relay reads `~/.relay/` for the channel: feed events, decision log entries (with rationale + alternatives), ticket DAG state, files touched per ticket. Joins them into a structured markdown brief. No LLM, no token cost.
- **Agent-authored gaps.** The departing agent fills in what's only in working memory: current line of attack, last hypothesis being tested, why specific approaches were abandoned, open questions it was about to chase.

Rejected: artifacts-only (misses irreplaceable working memory) and agent-only (the agent running out of tokens is the worst time to ask it for a long synthesis pass).

### 2. Trigger: explicit, with 90% nudge

Default: **explicit only** — user runs `rly handoff <channelId> --to <alias>` (or `--provider codex`) when they decide.

Soft prompt at **90% context window usage**: Relay surfaces a "you're at 90%, want to hand off?" prompt. User says yes → handoff fires. User says no → continue. Human-in-the-loop, no auto-trigger ever.

Rejected: hard auto-trigger at any threshold (loses user agency); pure-explicit with no warning (user discovers the problem only when the agent has already crashed).

### 3. Telemetry shared with context-window bar

Critical insight: the 90% nudge and the context-window display bar (separate phase) read from the **same per-session token-usage signal**. Build the telemetry plumbing once, the bar consumes it for display, the handoff system consumes it for the threshold prompt.

That's why the context-window bar phase is a **prerequisite** for the handoff phase, not a sibling.

## Open questions to resolve in plan-phase

- **Brief shape.** Markdown sections? What slots does the deterministic synthesizer leave open for the agent's gap-filling? (Suggested slots: `Current line of attack`, `Active hypothesis`, `Abandoned approaches and why`, `Open questions`.)
- **Provider portability of context info.** Claude exposes context info differently than Codex. Need a small adapter layer to read remaining context per provider. Spike candidate.
- **CLI surface.** `rly handoff <channelId> --to <alias>` vs `--provider <name>`. The alias form is more flexible (named sessions in different providers); the provider form is the common case. Probably support both with `--to` taking either.
- **What gets seeded in the new session.** Just the brief, or brief + recent N feed events for context? Assume brief-only first; revisit if briefs feel thin in practice.
- **LLM polish later?** Start deterministic. If briefs feel rough in practice, add an optional LLM polish pass over the deterministic skeleton. Defer.

## Why this design works

- **Leverages existing persistence.** Relay already writes everything we need to disk. The synthesizer is mostly a deterministic join of JSONL files.
- **Cheap when it has to be.** The deterministic skeleton costs zero tokens — important when the trigger is precisely "user is running out of tokens."
- **Doesn't fight the user.** Explicit trigger respects intent. The 90% nudge is information, not coercion.
- **Reuses telemetry.** The context-window bar and handoff threshold are one signal in two surfaces.
- **Extends naturally.** Same machinery serves "resume after a week" without any extra work.
