# Providers

> Relay is pre-v1 — see the [top-level beta note](../README.md#what-relay-is) in the README. This page is accurate as of the current release; CLI flags and the named-profiles surface may change. Issues and PRs welcome.

Relay dispatches work through CLI-based coding agents. Out of the box it ships adapters for two:

- **Claude** (Anthropic's `claude` CLI)
- **Codex** (OpenAI's `codex` CLI)

Neither adapter is hard-wired to a single vendor's endpoint. Because both CLIs respect standard base-URL environment variables, **any provider exposing an OpenAI-compatible or Anthropic-compatible HTTP API can be reached through the existing adapters with zero code changes**. This document lists the known-good combinations and shows the env vars you need.

> If you want a native adapter for a coding CLI that is neither Claude- nor Codex-compatible (e.g. `cursor-agent`, `gemini`), that's a different feature — see the "native adapters" note at the bottom.

## How it works

Relay's CLI adapters (`src/agents/cli-agents.ts`) shell out to the `claude` / `codex` binary with structured-output flags. The subprocess env is sanitised by default, but each adapter opts a small allowlist back in so the underlying CLI can pick up its own auth config:

- `ClaudeCliAgent` forwards: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, plus AWS / Vertex credentials.
- `CodexCliAgent` forwards: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`, `AZURE_OPENAI_*`, `CODEX_HOME`.

Set the right ones in your shell and Relay picks them up. No config file needed.

## Selecting a provider

```bash
# default provider for all dispatched agents
export HARNESS_PROVIDER=claude   # or codex

# per-agent overrides (agent ids: atlas, pixel, forge, lens, probe)
export HARNESS_AGENT_ATLAS_PROVIDER=codex
export HARNESS_AGENT_ATLAS_MODEL=gpt-4.1-mini
```

`rly run "<feature request>"` then routes each agent through its configured provider.

## Recipes

All recipes assume you've installed the underlying CLI (`claude` or `codex`) and have `rly` on your PATH.

### OpenAI-compatible providers through Codex

Set `HARNESS_PROVIDER=codex`, then point the OpenAI client at the provider's endpoint:

```bash
export HARNESS_PROVIDER=codex
export OPENAI_BASE_URL=<provider endpoint>
export OPENAI_API_KEY=<your key>
export HARNESS_AGENT_ATLAS_MODEL=<provider model id>
# (repeat the MODEL override for pixel / forge / lens / probe as needed)
```

Known-good endpoints:

| Provider   | `OPENAI_BASE_URL`                      | Example model id            |
| ---------- | -------------------------------------- | --------------------------- |
| MiniMax    | `https://api.minimax.io/v1`            | `MiniMax-M2`                |
| OpenRouter | `https://openrouter.ai/api/v1`         | `anthropic/claude-sonnet-4` |
| DeepSeek   | `https://api.deepseek.com/v1`          | `deepseek-coder`            |
| Groq       | `https://api.groq.com/openai/v1`       | `llama-3.3-70b-versatile`   |
| Together   | `https://api.together.xyz/v1`          | `Qwen/Qwen2.5-Coder-32B`    |
| LiteLLM    | `http://localhost:4000` (your gateway) | whatever you've proxied     |
| vLLM       | `http://localhost:8000/v1`             | your served model           |

Models with weak instruction-following or no structured-output support will produce results the orchestrator rejects. If a provider refuses Codex's `--output-schema` flag, it's not viable through this path.

> Want to save these env vars under a reusable name? See [Named profiles](#named-profiles) below — `rly providers profiles add <id>` persists the recipe to `~/.relay/provider-profiles.json` (secrets stay in your shell).

### Anthropic-compatible providers through Claude

Set `HARNESS_PROVIDER=claude` and point the Anthropic client at the alternate endpoint:

```bash
export HARNESS_PROVIDER=claude
export ANTHROPIC_BASE_URL=<provider endpoint>
export ANTHROPIC_AUTH_TOKEN=<your key>
export ANTHROPIC_MODEL=<provider model id>
```

This works for any proxy that speaks the Anthropic `/v1/messages` protocol (LiteLLM in Anthropic-compat mode, Bedrock proxies, etc.). For native Bedrock / Vertex, use the Claude CLI's own flags (`CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1`) plus the appropriate cloud credentials — both are already in the env allowlist.

## Named profiles

A "provider profile" is a named bundle of adapter + env overrides + default model that you can save once and refer to by id later. Profiles live at `~/.relay/provider-profiles.json`. The dispatch path consumes them: a channel pinned to a profile via `rly channel set-provider` (or the GUI dropdown) runs through that profile's adapter + envOverrides + default model. Resolution order is channel profile → global default (`rly providers default <id>`) → legacy `HARNESS_PROVIDER` env.

**Profiles never store secrets.** The profile JSON references env-var _names_ via `apiKeyEnvRef` and stores non-secret `envOverrides` (base URLs, org ids, model names). You still export the actual key in your shell the way you do today. `rly providers profiles add` rejects any `--env KEY=VAL` whose value looks like a raw API key and points you at `--api-key-ref` instead.

```bash
# Create a profile for MiniMax on the Codex adapter.
rly providers profiles add minimax \
  --adapter codex \
  --display-name "MiniMax (M2)" \
  --env OPENAI_BASE_URL=https://api.minimax.io/v1 \
  --api-key-ref MINIMAX_API_KEY \
  --model MiniMax-M2

# Inspect / list / remove / mark default.
rly providers profiles list
rly providers profiles show minimax
rly providers profiles remove minimax
rly providers default minimax     # set default
rly providers default             # print default
rly providers default clear       # unset default
```

`id` must match `[a-z0-9-]{1,32}`. `displayName` defaults to the id. `--env` can be repeated. Every CLI command above accepts `--json` for machine-readable output (which the GUI Tauri layer uses).

To pin a channel to a profile:

```bash
rly channel set-provider <channelId> <profileId>   # pin
rly channel set-provider <channelId> clear         # inherit default / HARNESS_PROVIDER
```

The GUI exposes the same surface: Settings drawer → About → Provider dropdown on each channel, and a Providers tab in the global Settings page for full CRUD.

## Native adapters (not yet)

Everything above goes through the Claude or Codex CLI. Providers that ship their _own_ coding CLI (Cursor's `cursor-agent`, Google's `gemini`, Aider, etc.) need a native adapter — new class in `src/agents/cli-agents.ts`, new case in `src/agents/factory.ts`, widened `AgentProvider` union in `src/domain/agent.ts`, matching widening in `crates/harness-data/src/lib.rs`. That's a bigger change and isn't done yet. If you want it for a specific CLI, open an issue describing the CLI's arg shape and structured-output story.

Providers that are API-only (no coding CLI, no file/tool-use loop) can't be dropped in as a peer of Claude or Codex at all — Relay dispatches _agentic sessions_, not single LLM completions.
