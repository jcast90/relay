---
title: CLI UX is a state-trust problem, not an invocation problem
date: 2026-05-09
context: Reframe surfaced during /gsd-explore on the "make rly easier to use" thread. We started thinking about slash commands and intent-inference hooks, but the actual user pain is about not knowing what state the system is in.
---

# CLI UX: trust over invocation

## The reframe

The original framing was "users don't know what they can do with `rly`," and the obvious solutions were (a) curated `/relay-*` slash commands for discoverability, (b) richer MCP tool descriptions, (c) a beefier system prompt, and (d) Claude/Codex hooks for intent inference. Those are all real levers — but the user's actual pain isn't about *invoking* a feature.

The pain is **trust in system state**:

1. **Setup trust:** "Are the right repos actually connected to this project / feature?"
2. **Boot trust:** "Did my repo-admin agents spawn? Have they finished context collection? Are they ready to receive tasks?"
3. **Run trust:** "Is the work flowing? Are agents stuck? Are they talking to each other?"

Slash commands let a user *ask* the system. Hooks/inference let an agent *act* without explicit syntax. Neither makes the system *announce its own state* to the user.

## Why this matters for product direction

Relay's distinctive capability is **multi-repo coordination**: a per-repo `repo-admin` agent that spawns ephemeral per-task teams in worktrees, all talking to each other through typed coordination messages and a shared channel feed. The value proposition is that the user can fire-and-forget across repos.

But fire-and-forget only works if the user trusts the system. Without a visible "here's what's wired up, here's who's online, here's what they're doing" surface, users don't know if their messages went anywhere, if agents are real, or if work is actually happening.

The CLI UX problem is downstream of this. Slash commands are a *discoverability* fix; intent inference is an *ergonomics* fix; what's missing is **observability** — and observability is the prerequisite for both of the others to feel useful.

## What this implies for sequencing

- **Don't lead with slash commands or hook-based intent inference.** They're additive, not foundational. They make sense once the user can already see what's running.
- **Lead with the readiness handshake + project-rooted state surface.** That's the foundation users need before any of the invocation-layer improvements pay off.
- Slash commands and hooks can come later as a thin layer on top of a system that already broadcasts its state honestly.

## Open consequences

- The `SessionStart` hook idea from the original thread becomes much more compelling when there's actual state to inject ("Project X — repos A ✅ ready, B ⏳ booting, C ❌ not connected — 3 unread channel events").
- "Intent inference" reduces in scope: once state is visible, the agent doesn't need to *guess* what the user means by "the other repo" — the answer is right there in the injected context.
- The slash-command surface should map to *cross-repo / cross-session* moves (the Relay-distinctive ones), not to wrapping every MCP tool. That matches the trust-not-invocation framing: surfaces help users *act on* state they can already see.
