# Security policy

Relay is a personal open-source project, not a corporate product. This policy is a good-faith coordinated-disclosure template — please treat it as such.

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/jcast90/relay/security/advisories/new) to open a draft advisory. Include:

- Affected version — a commit hash, or the output of `rly --version`.
- A reproduction — minimal steps or a small script. Private repro repos are fine.
- Impact — what an attacker gets, and what prerequisites they need.

You can expect an acknowledgement within **72 hours**. Please do not open a public GitHub issue for suspected vulnerabilities until we've had a chance to discuss.

## Scope

**In scope:** the Relay codebase in this repository — CLI, MCP server, orchestrator, channel store, crosslink, dashboards, installer.

**Out of scope:**

- Vulnerabilities in Claude Code, Codex, or the `@aoagents/*` packages — please report those to their respective maintainers.
- Issues in your own code that Relay dispatches agents to operate on. Relay doesn't protect you from yourself when running with `RELAY_AUTO_APPROVE=1`; that's by design.
- Social-engineering a user into running a malicious issue URL / prompt. Prompt injection surfaces inside the agent's own trust boundary; see *Known-and-accepted risks* below.

## Known-and-accepted risks

These are deliberate trade-offs, not bugs. Please don't report them as vulnerabilities.

- **`RELAY_AUTO_APPROVE=1` disables every permission check** in Claude and Codex (`--dangerously-skip-permissions` / `--full-auto`). That is the entire point of the flag — it exists so multi-hour unattended runs don't stall on prompts. Use it only when you trust the tasks you're dispatching.
- **macOS Terminal spawning via `osascript`** requires the user to grant Automation permissions to their terminal once. Once granted, Relay can open Terminal tabs and run `rly claude` in them without further prompts. This is a feature (spawning associated-repo agents) not a privilege escalation.
- **MCP tools run with the agent's full access.** Relay does not sandbox what Claude/Codex do inside a session — if the agent has shell access, so does anything it gets prompt-injected into running. Run Relay inside a dedicated workspace / user account if you need tighter isolation.
- **Tokens live in `~/.relay/config.env`** with standard Unix permissions. `GITHUB_TOKEN`, `LINEAR_API_KEY`, `COMPOSIO_API_KEY`, and any other secrets you put there are readable by anything running as your user. If someone has read access to your home directory, they have your tokens.

## Supported versions

Pre-1.0. Only `main` is supported — there is no LTS branch. Fixes land as new commits on `main`; there are no backports.

## Credit

If you report a valid issue and want credit, I'm happy to name you in the release notes or commit message. If you'd rather stay anonymous, that's fine too.
