---
title: Rewrite README top section with pain-point hook
date: 2026-05-09
priority: high
---

# Rewrite README top section

## Why

The current lead — "Slack for your coding agents" — undersells Relay's actual differentiator. The Slack metaphor implies side-by-side chat. The real unlock is a **delegation hierarchy across repo boundaries**: one orchestrator agent the user talks to, that can reach into other repos and delegate to agents there, which can spawn their own sub-agents/teams.

The dominant pain in the agent-harness space is that most tools assume work happens in a mono-repo. That's not the reality for anyone running a real product surface (UI repo, BE repo, ML/services repo, infra repo). Relay's entire shape addresses that. The README should lead with it.

## Direction

**Lead with the pain point, then show the mechanism, then mention cmux compat. Demote the GUI.**

Draft tagline:
> Agent harnesses assume your work lives in one repo. It doesn't.
>
> Relay lets one agent talk to agents in your other repos — delegate, coordinate, spin up sub-teams — across every codebase you own. Works natively with cmux.

## Concrete edits

- Replace the `<h1>Relay</h1>` tagline block at the top of `README.md` with the pain-point hook.
- Keep the "What makes Relay different" section but **reorder so cross-repo agent-to-agent delegation is bullet #1**, with copy that emphasizes the delegation tree (orchestrator → repo agents → sub-teams).
- Move the "three dashboards" bullet down. The GUI is a nice-to-have, not the headline.
- Add a short cmux-native-compat callout near the top — it's a meaningful proof point that we work with the broader ecosystem.
- Keep the audit-trail / decision-log bullet but reframe it as a **consequence** of cross-repo coordination, not a co-equal feature.
- Preserve the use-cases section as-is. It already works.

## Acceptance

- A first-time visitor reads the first screen and understands: (a) most harnesses assume one repo, (b) Relay doesn't, (c) the shape is a delegation tree across repos.
- "Slack for your coding agents" is gone or moved to a secondary metaphor for the chat feed only.
- GUI is mentioned but not the lead.
- cmux compat is visible above the fold.

## Notes

User signal: "if we can capture attention and interest in that first hook then we are set." Hook strength is the priority — the rest of the README rewrite can be conservative as long as the lead lands.
