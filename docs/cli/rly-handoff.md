# `rly handoff` — generate a handoff brief and (optionally) seed a fresh session

Handoff brief synthesizer + new-session dispatcher. Generates a structured markdown brief from a channel's `~/.relay/` artifacts (feed, decisions, tickets, run links, files-touched via `git log`), optionally captures the departing agent's working memory through the `channel_handoff_finalize` MCP tool, and seeds a fresh session in the destination provider — instead of replaying the raw transcript.

For the design rationale and full schema, see [`docs/design/handoff-brief.md`](../design/handoff-brief.md).

## Synopsis

```
rly handoff <channelId> [--to <profile|adapter|alias>]
                        [--save]
                        [--resume <briefId|latest>]
                        [--max-tokens <n>]
                        [--force]
                        [--wait-gap <ms>]
                        [--json]
```

## Description

A "handoff" turns Relay's on-disk channel state into a focused, provider-portable, ~3–4K-token brief and uses it as the first turn of a new session. The brief is built deterministically from artifacts the channel already owns, plus four agent-authored working-memory slots the departing agent voluntarily fills in via the `channel_handoff_finalize` MCP tool. If the departing agent doesn't fill them in, the brief still renders successfully with `[gap-fill not provided]` placeholders.

Use it when:

- A session approaches its context window limit (Relay's threshold listener nudges the user at 90% via the approval queue).
- The user wants to switch providers mid-task (Claude → Codex or vice-versa).
- The user is parking a channel and intends to resume in days/weeks (combine `--save` + `--resume latest`).

## Modes

`rly handoff` runs in exactly one of three modes per invocation. `--save` and `--to` are mutually exclusive.

### `--to <value>` — dispatch a fresh session (STRICT validation)

```
rly handoff ch-abc123 --to claude
rly handoff ch-abc123 --to codex
rly handoff ch-abc123 --to anthropic-default       # provider-profile id
rly handoff ch-abc123 --to api                     # channel repo alias
```

Builds the brief, runs **STRICT** validation (token cap + missing sections + secrets), persists `<briefId>.{md,gap.json}` under `~/.relay/channels/<channelId>/handoffs/`, and dispatches a fresh session in the resolved destination with the brief as its first turn.

### `--save` — persist without dispatching (PERMISSIVE validation)

```
rly handoff ch-abc123 --save
```

Builds and persists the brief, runs **PERMISSIVE** validation (secret-pattern only — no token cap, no missing-section rejection), and **does NOT** spawn a destination session. Use this when archiving a channel for later resume; the cap is enforced when the brief is later resumed via `--to`.

### `--resume <briefId|latest> --to <value>`

```
rly handoff ch-abc123 --resume latest --to claude
rly handoff ch-abc123 --resume brief-1714339200-x7k2 --to codex
```

Reads ONLY the saved `<briefId>.gap.json` (M7 — the saved `<briefId>.md` is a snapshot, not re-consumed). Regenerates the deterministic skeleton from current channel state, reuses the saved working-memory slots, persists a new `<newBriefId>.{md,gap.json}` pair carrying a `**Resumed from:** <briefId>` header line, and dispatches a fresh destination session.

`--resume latest` selects the most-recent `briefId` from the channel's `handoffs/` directory. Pass `--save` instead of `--to` to re-archive with the same gap-fill (e.g. for round-tripping after editing the channel feed).

## Flags

| Flag                         | What it does                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--to <value>`               | Resolve a destination provider profile / adapter / repo alias. Mutually exclusive with `--save`.                                                                |
| `--save`                     | Persist the brief without dispatching. Mutually exclusive with `--to`.                                                                                          |
| `--resume <briefId\|latest>` | Reload a saved gap.json and regenerate the skeleton. Compose with `--to <dest>` to dispatch, or alone to re-archive.                                            |
| `--max-tokens <n>`           | Override the 8,000-token hard cap (STRICT mode only — PERMISSIVE skips the cap regardless).                                                                     |
| `--force`                    | Bypass STRICT-mode validation **errors** (token-cap, missing-section). **Does NOT** bypass secret-pattern errors — those are hard in both modes.                |
| `--wait-gap <ms>`            | Time to wait for a fresh `<briefId>.gap.json` to appear after the CLI posts the dashboard-visible handoff prompt. Default `30000`. Set to `0` to skip the wait. |
| `--json`                     | Emit a single-line JSON result envelope on stdout instead of human text.                                                                                        |

## `--to` resolution order (D-03)

`--to <value>` is resolved through a four-step layered fallback. The first match wins:

1. **Exact provider-profile id.** `rly providers` lists configured profiles (e.g. `anthropic-default`, `openai-prod`).
2. **Adapter shorthand.** `claude` or `codex` resolve to the default profile for that adapter (or the bare adapter if no profile is configured).
3. **Channel repo alias.** Any alias listed in the channel's `repoAssignments` (see `rly channel <channelId>`). Resolves through the channel's `providerProfileId` if set, else the system-default profile.
4. **No match.** Hard error — the message lists the three places to check.

Examples:

```
rly handoff ch-abc123 --to anthropic-default       # step 1: profile id
rly handoff ch-abc123 --to claude                  # step 2: adapter shorthand
rly handoff ch-abc123 --to api                     # step 3: repo alias
rly handoff ch-abc123 --to <typo>                  # step 4: error
```

## Examples

```bash
# Hand off a Claude session to Codex.
rly handoff ch-abc123 --to codex

# Save without dispatching — for later resume.
rly handoff ch-abc123 --save

# Resume after a week.
rly handoff ch-abc123 --resume latest --to claude

# Force a too-long brief through STRICT validation (secrets are still hard).
rly handoff ch-abc123 --to claude --force

# Skip the gap-fill wait (useful in scripts when no live agent is around).
rly handoff ch-abc123 --to claude --wait-gap 0

# JSON-only output, suitable for piping.
rly handoff ch-abc123 --save --json | jq '.briefPath'
```

## Output

Human mode (default) on success:

```
Wrote brief: ~/.relay/channels/ch-abc123/handoffs/brief-1714339200-x7k2.md
Wrote gap-fill: ~/.relay/channels/ch-abc123/handoffs/brief-1714339200-x7k2.gap.json
Token estimate: 3142
Dispatched: codex → My Codex Profile
Session id: sess-codex-7
```

`--json` mode on success:

```json
{
  "ok": true,
  "channelId": "ch-abc123",
  "briefId": "brief-1714339200-x7k2",
  "briefPath": "/Users/me/.relay/channels/ch-abc123/handoffs/brief-1714339200-x7k2.md",
  "gapJsonPath": "/Users/me/.relay/channels/ch-abc123/handoffs/brief-1714339200-x7k2.gap.json",
  "fromSessionId": "sess-claude-12",
  "toSessionId": "sess-codex-7",
  "toProvider": "codex",
  "tokenEstimate": 3142,
  "mode": "to"
}
```

`--json` mode on validation failure:

```json
{
  "ok": false,
  "errors": ["brief exceeds 8000-token cap (got 9241)"],
  "warnings": [
    "working-memory placeholder used; departing agent did not call channel_handoff_finalize"
  ]
}
```

Exit codes:

- `0` — success.
- `1` — channel-not-found, validation failure, spawn failure, or unknown `--to`.
- `2` — argv-parse error (unknown flag, missing value, mode conflict).

## File layout

Brief artifacts persist under the channel:

```
~/.relay/channels/<channelId>/handoffs/
  brief-<unix>-<rand>.md         # rendered markdown
  brief-<unix>-<rand>.gap.json   # working-memory slots, schemaVersion: 1
```

`<briefId>` matches the regex `/^brief-[0-9]+-[a-z0-9]+$/` and is path-safe by construction (`assertSafeSegment` + `assertValidBriefId`).

## Validation modes

The synthesizer always runs the same validators; the **mode** decides which classes of error are fatal.

| Mode           | Trigger        | Token cap (8K)                       | Missing sections                     | Secret patterns             |
| -------------- | -------------- | ------------------------------------ | ------------------------------------ | --------------------------- |
| **STRICT**     | `--to <value>` | hard error (override with `--force`) | hard error (override with `--force`) | **hard error, no override** |
| **PERMISSIVE** | `--save`       | warning only                         | warning only                         | **hard error, no override** |

The rationale for PERMISSIVE: `--save` is for archival. The user may legitimately produce an oversized brief and trim it later via `--resume`. Secrets, however, must never land on disk regardless — that's why secret-pattern errors are hard in both modes.

Secret patterns scanned (defense in depth — pattern names are reported, but matched substrings are never printed):

- AWS access-key: `AKIA[A-Z0-9]+`
- OpenAI-style: `sk-[A-Za-z0-9]+`
- Generic key=value: `(secret|password|token|api[_-]?key)\s*[:=]\s*\S+` (case-insensitive)
- PEM block: `-----BEGIN [A-Z ]+ KEY-----`

## Related

- Design doc: [`docs/design/handoff-brief.md`](../design/handoff-brief.md) — schema, threat model, end-to-end flow.
- Phase 1 contract: [`docs/design/context-threshold-events.md`](../design/context-threshold-events.md) — the 90% feed-entry contract that drives the threshold listener.
- MCP tool: `channel_handoff_finalize` — see `rly inspect-mcp`.
- Approval-queue surfaces: `rly pending-approvals`, `rly approve <id>`, `rly reject <id>`.
