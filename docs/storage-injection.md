# Storage Injection

Relay's persistent state lives behind a single interface, `HarnessStore`
(`src/storage/store.ts`). Two implementations ship today:

- **`FileHarnessStore`** — rooted at `~/.relay/`, atomic JSON/JSONL writes. The
  default, and the right choice for solo dev, CI, and single-host deployments.
- **`PostgresHarnessStore`** — backed by your own Postgres. Use this for
  multi-agent deployments where `LISTEN/NOTIFY` broadcasts and row-locked
  decision writes matter. Select it via `HARNESS_STORE=postgres` +
  `HARNESS_POSTGRES_URL`.

## Goal

Let the harness run against a local filesystem during development and
against Postgres in shared deployments by changing an environment variable,
not by editing handlers. All backend selection flows through one place:
`buildHarnessStore()` in `src/storage/factory.ts`.

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

| `HARNESS_STORE` | Behavior                                                    |
| --------------- | ----------------------------------------------------------- |
| unset / `file`  | `FileHarnessStore` at `getRelayDir()` (usually `~/.relay/`) |
| `postgres`      | Throws `NotImplementedError` until T-402 lands              |
| `sqlite`        | Throws `NotImplementedError` (no tracking ticket yet)       |

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

## Adding a new backend

1. Implement `HarnessStore` in a new file under `src/storage/`.
2. Widen `StoreKind` in `factory.ts` if a new env value is needed.
3. Wire it into `buildHarnessStore()` behind its `StoreKind`.
4. Replace the `NotImplementedError` throw.

The Postgres impl (T-402) will use `LISTEN/NOTIFY` instead of mtime polling
for `watch`, and Postgres advisory locks instead of the in-process promise
mutex for `mutate`. The interface contract is designed to accommodate both
without changes.
