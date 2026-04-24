# Awesome-list submission drafts

Copy-paste content for the two awesome-lists that require human submission via web UI (both block programmatic submission — do not use `gh` CLI or scripts).

---

## 1. awesome-claude-code (40.6k stars)

**Submit at:** https://github.com/hesreallyhim/awesome-claude-code/issues/new/choose → select **🚀 Recommend New Resource**

**Important:** must be submitted via the GitHub web UI (logged in as a human). Do not use the CLI — the list's Code of Conduct auto-closes and flags CLI submissions.

### Form field values

| Field | Value |
|---|---|
| **Display Name** | `Relay` |
| **Category** | `Tooling` |
| **Sub-Category** | `Tooling: Orchestrators` |
| **Primary Link** | `https://github.com/jcast90/relay` |
| **Author Name** | `jcast90` |
| **Author Link** | `https://github.com/jcast90` |
| **License** | `MIT` |

**Description** (paste into the Description textarea; no emojis, descriptive not promotional):

> Local-first orchestrator that runs inside an existing Claude or Codex CLI via MCP. Classifies a request, decomposes it into tickets with a dependency DAG, dispatches across one or more repos, and supervises with live PR tracking and approval gates. CLI, TUI (ratatui), and Tauri GUI dashboards read the same on-disk state — no hosted service, no telemetry.

**Validate Claims** (optional but strongly recommended — the maintainer asks his Claude Code agent to verify claims):

> Install globally with `npm install -g @jcast90/relay`, run `rly welcome` in any repo, then `rly claude` to launch Claude CLI with the Relay MCP server attached. Paste a GitHub issue URL as the first message — Relay classifies the complexity tier, generates a plan (requesting user approval for feature_large or architectural work), and executes via decomposed tickets without leaving the Claude session.

**Specific Task(s)** (optional):

> Give Claude any single-repo software change — e.g., "Add OAuth2 to /api/users" or a GitHub issue URL like `https://github.com/owner/repo/issues/42`. Relay's MCP server will take over: it classifies complexity, decomposes into tickets, runs verification commands against an allowlist, and opens a PR. Multi-repo work is also supported through the channel model + crosslink MCP tools.

**Specific Prompt(s)** (optional):

> `Add a health endpoint to this repo`
>
> or paste a GitHub issue URL directly as the first message

---

## 2. awesome-mcp-servers (85.4k stars)

**Submit at:** https://mcpservers.org/submit

**Important:** the list no longer accepts GitHub PRs — submission goes through the mcpservers.org portal.

### Form field values (expected — verify on the form)

| Field | Value |
|---|---|
| **Name** | `Relay` |
| **Repository** | `https://github.com/jcast90/relay` |
| **Category** | `Coding Agents` |
| **License** | `MIT` |

**Short description:**

> Local-first orchestrator that classifies, decomposes, dispatches, and supervises AI coding work across one or more repos — runs inside Claude or Codex CLI via an MCP server. No hosted service, no telemetry; state stored in `~/.relay/`.

**Long description:**

> Relay wraps Claude and Codex CLI sessions with an MCP server that turns a single request into a plan, decomposes it into tickets with a dependency DAG, dispatches them to agents across one or more repos, and tracks long-running work with a durable decision log. Agents in different repos discover each other through crosslink MCP tools (`crosslink_discover`, `crosslink_send`, `crosslink_poll`) and coordinate without sharing full context. Supervision surfaces include a CLI (`rly`), a ratatui TUI, and a Tauri desktop app — all reading the same `~/.relay/` on-disk state.
>
> Built for individual developers and teams who need multi-hour agent runs with provenance (per-decision rationale, alternatives, linked artifacts) and who prefer running on their own machine over sending code to a hosted service. Provider-agnostic — any OpenAI-compatible or Anthropic-compatible endpoint works (MiniMax, OpenRouter, DeepSeek, Groq, Together, LiteLLM, vLLM).

**Installation:**

```bash
npm install -g @jcast90/relay
rly welcome
```

**Tags / keywords** (if the form allows):

`agent-orchestration`, `coding-agent`, `claude-cli`, `codex-cli`, `multi-repo`, `local-first`, `self-hosted`, `mcp-server`

**MCP tools exposed** (if asked):

- Harness: `harness_status`, `harness_list_runs`, `harness_get_run_detail`, `harness_get_artifact`, `harness_approve_plan`, `harness_reject_plan`, `harness_dispatch`, `project_create`
- Channels: `channel_create`, `channel_get`, `channel_post`, `channel_record_decision`, `channel_task_board`, `harness_running_tasks`
- Crosslink: `crosslink_discover`, `crosslink_send`, `crosslink_poll`

---

## After-submission checklist

- [ ] awesome-claude-code issue opened (link: )
- [ ] awesome-mcp-servers portal submission confirmed (link: )
- [ ] awesome-cli-coding-agents PR status tracked: https://github.com/bradAGI/awesome-cli-coding-agents/pull/59

## Skipped lists

- **e2b-dev/awesome-ai-agents** (27.4k) — last push 2025-02-26, abandoned
- **agarrharr/awesome-cli-apps** (19.4k) — Relay fails the 20-star / 90-day minimums (1 star, 24 days old); revisit in ~2 months if Relay passes both thresholds
- **Shubhamsaboo/awesome-llm-apps** — scope is runnable example apps, not tools
- **kaushikb11/awesome-llm-agents** — scope is agent frameworks, not orchestrators
