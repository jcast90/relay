# Storage Injection

Relay's persistent state lives behind a single interface, `HarnessStore`
(`src/storage/store.ts`). **Today, File backend only.**

- **`FileHarnessStore`** — rooted at `~/.relay/`, atomic JSON/JSONL writes.
  The default, and the only implementation wired into the factory.

A `PostgresHarnessStore` stub lives at `src/storage/postgres-store.ts` for
future multi-agent coordination (`LISTEN/NOTIFY` cross-agent decision
broadcasts, row-locked decision writes), but it isn't wired through the
factory. See the [Roadmap](../README.md#roadmap).

## Goal

Let the harness run against a local filesystem today without forcing every
handler to know how the state is stored. All backend selection flows
through one place: `buildHarnessStore()` in `src/storage/factory.ts`. The
single-interface shape keeps a future backend drop-in work rather than a
handler rewrite.

## Composition root

The CLI entry (`src/index.ts`) holds the single cached instance:

```ts
import { getHarnessStore } from "./index.js";
const store = getHarnessStore();
```

Downstream modules should take `HarnessStore` as a constructor argument and
accept it from their caller — they must not call `buildHarnessStore()`
themselves. That keeps tests free to substitute in-memory fakes without a
global side-effect.

## Environment

| `HARNESS_STORE`       | Behavior                                                    |
| --------------------- | ----------------------------------------------------------- |
| unset / `file`        | `FileHarnessStore` at `getRelayDir()` (usually `~/.relay/`) |
| `postgres` / `sqlite` | Warns once, falls back to the file backend (see below)      |
| any other value       | Silently falls back to the file backend                     |

The factory never throws on an unsupported backend — old docs and user
scripts still reference `HARNESS_STORE=postgres`, and crashing those
callers on startup would be a worse experience than quietly degrading. A
one-line `console.warn` fires when a recognized-but-unimplemented kind is
requested, so operators see the degradation.

## Legacy stores (unmigrated)

These five modules still import `node:fs/promises` directly. They predate
`HarnessStore` and migrate one ticket at a time so each PR stays
reviewable:

| File                              | Ticket          |
| --------------------------------- | --------------- |
| `src/channels/channel-store.ts`   | T-101 (partial) |
| `src/cli/workspace-registry.ts`   | T-102 (partial) |
| `src/cli/session-store.ts`        | T-102 (partial) |
| `src/execution/artifact-store.ts` | T-103           |
| `src/crosslink/store.ts`          | T-104           |

Until those tickets land, these files are exempt from a "no direct fs in
storage code" lint. The canonical list lives as a comment in
`src/storage/factory.ts` so it stays in sync with the code.

T-101 and T-102 followed Option A: the ctor takes an injected
`HarnessStore` and migrates coordination primitives (registry-level and
per-session mutation records) through it, while the authoritative data
stays on the filesystem paths the Rust crate `harness-data` reads. The
remaining ticket for each file covers migrating the authoritative reads
once the Rust reader is updated.

Other `node:fs/promises` importers in `src/` (bootstrap, config, agent
wrapper, MCP server, scripted invoker, etc.) are not storage backends —
they don't migrate and aren't part of the allowlist.

## Future work

The `PostgresHarnessStore` stub at `src/storage/postgres-store.ts` would,
when wired:

- Replace mtime polling in `watch` with `LISTEN/NOTIFY` so multiple agents
  (same host or different) see decision writes without filesystem tailing.
- Use Postgres advisory locks instead of the in-process promise mutex in
  `mutate`, so cross-process coordination is a first-class primitive.

Postgres here is not a cloud requirement — it runs fine locally
(`brew install postgresql && createdb relay`). The value is multi-agent
coordination, not cloud. Wiring this up is tracked in the
[Roadmap](../README.md#roadmap).

## Adding a new backend (for reference)

1. Implement `HarnessStore` in a new file under `src/storage/`.
2. Widen `StoreKind` in `factory.ts` if a new env value is needed.
3. Wire it into `buildHarnessStore()` behind its `StoreKind`.
4. Drop the warn-and-fallback branch for that kind.
