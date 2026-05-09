BRANCH=INCONCLUSIVE
STREAM_FLAG=NONE
CODEX_VERSION=not installed
SCHEMA_PATH=fallback-empty-schema
USAGE_PRESENT=unknown

# A1 spike — Codex `--output-schema` usage extraction

Status: INCONCLUSIVE — `codex` CLI not available in this execution
environment. Permissions for ad-hoc PATH probing were blocked by the
sandbox, and the live invocation step (`codex exec --output-schema ...`)
could therefore not be exercised.

## Goal

Confirm whether `codex exec --output-schema <schema> -o <out>` writes a
top-level `usage` block into the response file. The answer routes Task 3
(adapter usage extraction) to one of three branches:

- **Branch A (assumption holds):** `response.json` carries top-level
  `usage: { input_tokens, cached_input_tokens?, output_tokens }`. Task 3
  parses it directly. `STREAM_FLAG=NONE`.
- **Branch B (assumption fails):** `response.json` does NOT carry
  `usage`. Task 3 must additionally pass a JSONL stream flag (e.g.
  `--json`) and capture the last `turn.completed.usage`. `STREAM_FLAG=<flag>`.
- **Branch INCONCLUSIVE:** `codex` CLI unavailable. Task 3 implements
  Branch A only and emits a stderr warning (`[budget] Codex usage
  extraction unavailable; bar will not update for this session. Re-run
  the A1 spike with codex installed to enable telemetry.`) when
  `parsed.usage` is undefined post-Codex-run. `STREAM_FLAG=NONE`.

This spike file is INCONCLUSIVE per the third bullet. Task 3 (PR-2) will
implement Branch A with the Codex-unavailable stderr warning. Future
re-spike (when `codex` is installed in the executor's PATH) should
overwrite the first 5 lines of this file with the resolved branch.

## Reproduction commands (for re-spike)

When `codex` becomes available, re-run:

```bash
# Option 1 — use the canonical AgentResultSchema:
node -e 'import("zod-to-json-schema").then(({zodToJsonSchema}) => import("./dist/domain/agent.js").then(({AgentResultSchema}) => process.stdout.write(JSON.stringify(zodToJsonSchema(AgentResultSchema), null, 2))))' > /tmp/relay-spike-schema.json

codex exec --skip-git-repo-check --sandbox read-only \
  --output-schema /tmp/relay-spike-schema.json \
  -o /tmp/relay-spike-response.json \
  "Return a JSON object with summary='ok', evidence=[], proposedCommands=[], blockers=[]."
cat /tmp/relay-spike-response.json
```

If `zod-to-json-schema` is not on the dep tree, the L6 fallback is to
pass `{}` (empty schema) — that still answers whether `usage` lands in
the response. Document which path was taken in `SCHEMA_PATH=` above.

## Outcome

INCONCLUSIVE. Per the M2 mitigation, Task 3 in PR-2 will:

1. Implement Branch A only (`response.json` top-level `usage` parse).
2. After Codex completes, if `parsed.usage` is undefined, emit ONE
   stderr warning: `[budget] Codex usage extraction unavailable; bar
   will not update for this session. Re-run the A1 spike with codex
   installed to enable telemetry.`
3. The orchestrator (Task 4) guards with `if (result.tokenUsage)`, so a
   missing usage is a no-op for downstream consumers.

When the executor environment gets `codex` installed, re-running this
spike + flipping the first 5 lines is sufficient to enable the full
telemetry path. The Task 3 implementation must remain re-checkable
against this file (the spike test below greps the documented branch).
