# Data model

The core domain types. TS is canonical; Rust mirrors (in `crates/harness-data/src/lib.rs`) must be updated in the same PR when a TS shape changes, or the TUI/GUI will silently drop fields.

> TODO: expand as needed. Add field-level notes here when a type's shape stops being obvious from its zod schema.

## Canonical types

| Type                | TS definition                                                                     | Rust mirror                                                                        | Notes                                                                               |
| ------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `HarnessRun`        | `src/domain/run.ts` (interface `HarnessRun`)                                      | partially via `RunIndexEntry` + `TicketLedger` in `crates/harness-data/src/lib.rs` | One classifier→planner→scheduler execution. Lives under a channel.                  |
| `Channel`           | `src/domain/channel.ts` (interface `Channel`)                                     | `struct Channel` in `crates/harness-data/src/lib.rs`                               | Slack-like workspace for one piece of work. Members, pinned refs, repo assignments. |
| `ChannelEntry`      | `src/domain/channel.ts` (interface `ChannelEntry`)                                | `struct ChannelEntry`                                                              | Append-only feed row. `ChannelEntryTypeSchema` enumerates the types.                |
| `TicketLedgerEntry` | `src/domain/ticket.ts` (interface `TicketLedgerEntry`)                            | `struct TicketLedgerEntry`                                                         | Unit of parallel work. Deps DAG, retry budget, specialty tag.                       |
| `Decision`          | `src/domain/decision.ts` (interface `Decision`)                                   | `struct Decision`                                                                  | Rationale + alternatives. One file per decision under `channels/<id>/decisions/`.   |
| `CrosslinkSession`  | `src/crosslink/types.ts` (`CrosslinkSessionSchema` zod + `type CrosslinkSession`) | not mirrored — GUI reads live heartbeat JSON directly                              | Session heartbeat written to `~/.relay/crosslink/sessions/`.                        |
| `Spawn`             | `gui/src/types.ts` (`type Spawn`) + `channels/<id>/spawns.json` on disk           | not mirrored in `crates/harness-data/` — GUI reads the JSON directly               | Tracked spawned-terminal sessions (macOS GUI only).                                 |

## Enums and schemas worth knowing

- `ChannelStatus` (`"active" | "archived"`) — `src/domain/channel.ts`.
- `ChannelEntryType` — the union of feed entry types. Grep for `ChannelEntryTypeSchema`.
- `TicketStatus` transitions: `pending → blocked → ready → executing → verifying → retry → completed | failed`. See `src/domain/state-machine.ts`.
- Classification tiers: `trivial | bugfix | feature_small | feature_large | architectural | multi_repo`. See `src/domain/classification.ts`.
- Specialty tags: `general | ui | business_logic | api_crud | devops | testing`. See `src/domain/specialty.ts`.

## On-disk layout

The disk layout is documented in full in [`../README.md`](../README.md) under **File layout**. Key rules:

- Writes are atomic (temp-rename). See `src/storage/file-store.ts` and `src/channels/channel-store.ts`.
- `feed.jsonl` is append-only. Never rewrite.
- Decisions are one file per id.

## Mismatch-hunting checklist

When the TUI or GUI shows stale / missing data after a PR:

1. Did a field in `src/domain/` change? Does `crates/harness-data/src/lib.rs` know about it?
2. Is the Rust struct using `serde(default)` or `Option<…>` where the field might be absent on old files?
3. Is the write path atomic, or did a partial write land?
