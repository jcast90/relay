# agent_docs/

Agent-targeted reference material. Deeper than [`AGENTS.md`](../AGENTS.md) at the repo root, grep-friendly when that short doc didn't answer your question.

Written **for coding agents** (Claude Code, Codex, Cursor, etc.), not humans. Humans have [`docs/`](../docs/) and [`README.md`](../README.md).

## What's here

- [`architecture.md`](./architecture.md) — directory map, what each top-level dir owns, concrete source-file pointers.
- [`data-model.md`](./data-model.md) — the core domain types + where each one is defined in TS and mirrored in Rust.
- [`testing.md`](./testing.md) — vitest patterns used in the repo, scripted vs live mode, conventions.
- [`repo-admin.md`](./repo-admin.md) — foreman (repo-admin) / crew (workers) split in the autonomous loop, with MCP tool allowlist + enforcement notes (AL-11).

Each file is currently a minimal honest stub — extended as real gaps in agent knowledge become apparent. Better a short pointer at the real source than paragraphs of invented prose.

## When to expand this

Add to these files when you notice an agent (yourself included) burning context on a question that isn't covered here. Don't pre-fill. TODO-stubs > fluff.
