---
title: Review and land Phase 3 SUMMARY (draft PR #221)
date: 2026-05-11
priority: high
---

# Land Phase 3 SUMMARY

## Why

Phase 3 implementation (repo-admin readiness handshake — `CrosslinkSession.readyAt`, `agent_ready` MCP tool, `harness-data::load_crosslink_sessions`) was squashed into the planning-init commit (#216) on 2026-05-09. The closeout document for Phase 3 sits in draft PR #221 (`docs(planning): Phase 3 SUMMARY — readiness handshake implemented`) and hasn't merged.

**This blocks Phase 4 planning.** Phase 4 (project readiness surface) consumes the Phase 3 readiness primitive — without the SUMMARY merged, the readiness contract isn't captured anywhere on `main`, and the Phase 4 planner has to read PR descriptions + code to reconstruct what to build against. The same trust-gap that Phase 4 is meant to close would be present in our own planning materials.

## Direction

Two open items on PR #221 per its body:

1. **Manual smoke deferred.** The phase is verified by tests (989 vitest + 70 cargo) but a live `rly claude` run with a real agent — exercising system-prompt → agent-obediently-calls-`agent_ready` → disk + feed flow — was never executed. The doc has explicit "recommended steps to flip the doc to `manual_smoke: verified`."
2. **Reviewer eyeball requested** — confirm the wave-by-wave commit map matches what's on `main`.

## Concrete edits

- Run the manual smoke as documented in `03-SUMMARY.md` ("recommended steps").
- If smoke passes, edit `03-SUMMARY.md` to set `manual_smoke: verified` and push to the `docs/phase-3-summary` branch.
- If smoke surfaces issues, either fix them (new PR) or document the workaround in the SUMMARY before merging.
- Confirm the wave-by-wave map against `git log #216` (the squash commit).
- Merge #221 once both items are resolved.

## Acceptance

- `.planning/phases/03-repo-admin-readiness-handshake/03-SUMMARY.md` lives on `main`.
- `manual_smoke` field is either `verified` (smoke passed) or `deferred` with a clear reason (smoke deferred to a follow-up).
- Phase 4 planning can start with a stable readiness contract referenced from the SUMMARY.

## Blockers / risk

- Manual smoke requires a working `rly claude` setup with a real provider. If the smoke surfaces a system-prompt regression (agent doesn't call `agent_ready`), that's a code fix — separate PR — and the SUMMARY-merge unblocks once the fix lands.
