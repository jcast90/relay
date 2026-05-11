---
title: Re-run Phase 1 A1 spike when codex CLI is installed in CI
date: 2026-05-11
priority: low
---

# Codex A1 spike re-run

## Why

Phase 1's A1 spike (`.planning/phases/01-token-usage-telemetry-context-bar/01-SPIKE-A1.md`) was meant to resolve whether Codex emits usage as **Branch A** (top-level `response.usage` in the `--output-schema` response file) or **Branch B** (streaming `turn.completed.usage` events in a JSONL stream). When PR-1 ran the spike, `codex` CLI was not installed in the executor environment, so the spike returned `BRANCH=INCONCLUSIVE`.

Per the M2 mitigation, Task 3 in PR-2 (#223) implemented **Branch A only**. The orchestrator guards every record with `if (result.tokenUsage)`, so a missing usage is a no-op — Codex chat sessions silently report 0 % forever, no threshold events fire. Safe but blind.

## Direction

If Branch B turns out to apply, Task 3's adapter parser needs a second code path (a JSONL stream consumer for `turn.completed.usage`). The work is bounded but the spike must run first.

## Concrete edits

1. Install `codex` CLI in CI (or run the spike locally with `codex` installed).
2. Re-run the spike per the commands documented at the bottom of `01-SPIKE-A1.md`:
   ```
   <commands as documented in the spike file>
   ```
3. Overwrite the first 5 lines of `01-SPIKE-A1.md` with the resolved branch (`BRANCH=A` or `BRANCH=B`, `STREAM_FLAG`, `CODEX_VERSION`, `SCHEMA_PATH`, `USAGE_PRESENT`).
4. If `BRANCH=A`: no code change needed; spike resolution is documentation-only.
5. If `BRANCH=B`: implement the JSONL stream consumer in `src/agents/codex-cli-agent.ts`, add tests under `test/agents/cli-agents-codex-usage.test.ts` covering the streaming path, and verify the threshold-feed bridge fires for a Codex session.

## Acceptance

- `01-SPIKE-A1.md` has a resolved (non-INCONCLUSIVE) first-five-lines block.
- Codex chat sessions emit budget records with non-zero `cumulativeUsed` after a turn.
- If Branch B: `test/agents/cli-agents-codex-usage.test.ts` covers the streaming path.

## Notes

Lowest priority of the three followups. Phase 4 and Phase 5 do not depend on this. The risk is only that Codex users see a stuck 0 % bar — already documented in the Phase 1 SUMMARY's deferred-follow-ups section.
