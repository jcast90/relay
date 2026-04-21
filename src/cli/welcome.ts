import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface, Interface } from "node:readline/promises";
import { join } from "node:path";

import { getRelayDir } from "./paths.js";
import { listRegisteredWorkspaces } from "./workspace-registry.js";

const ONBOARDED_FILE = "onboarded.json";
const CONFIG_ENV = "config.env";
const CONFIG_ENV_TEMPLATE = "config.env.template";

export type ScaffoldResult =
  | { status: "created"; from: string; to: string }
  | { status: "already-exists"; path: string }
  | { status: "missing-template"; expectedTemplate: string };

/**
 * Copy `config.env.template` into `config.env` inside the given relay dir.
 * Idempotent — never overwrites an existing `config.env`. If the template is
 * missing (fresh clone without `install.sh` run, or a manual install), the
 * caller gets `missing-template` back so it can show the user the right hint.
 *
 * Exported for unit tests; `runWelcome` calls this when the user opts in.
 */
export async function scaffoldConfigEnv(relayDir: string): Promise<ScaffoldResult> {
  const target = join(relayDir, CONFIG_ENV);
  const template = join(relayDir, CONFIG_ENV_TEMPLATE);

  if (existsSync(target)) {
    return { status: "already-exists", path: target };
  }
  if (!existsSync(template)) {
    return { status: "missing-template", expectedTemplate: template };
  }

  await mkdir(relayDir, { recursive: true });
  await copyFile(template, target);
  return { status: "created", from: template, to: target };
}

// Catppuccin-ish ANSI for terminal output. Falls back gracefully on
// non-colour terminals — no library dependency.
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  blue: "\x1b[38;5;111m",
  mauve: "\x1b[38;5;183m",
  green: "\x1b[38;5;151m",
  peach: "\x1b[38;5;216m",
  red: "\x1b[38;5;211m"
};

export interface WelcomeOptions {
  /** Re-run even if ~/.relay/onboarded.json exists. */
  reset: boolean;
  /** Non-interactive: just print the tour, don't prompt. */
  nonInteractive: boolean;
}

export function parseWelcomeFlags(args: string[]): WelcomeOptions {
  return {
    reset: args.includes("--reset"),
    nonInteractive: args.includes("--non-interactive") || !process.stdin.isTTY
  };
}

/**
 * Has the user finished the welcome tour at least once? Cheap check used by
 * other commands (claude / codex) to offer a gentle nudge on first run.
 */
export function hasOnboarded(): boolean {
  try {
    return existsSync(join(getRelayDir(), ONBOARDED_FILE));
  } catch {
    return false;
  }
}

async function markOnboarded(): Promise<void> {
  const dir = getRelayDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, ONBOARDED_FILE),
    JSON.stringify({ onboardedAt: new Date().toISOString(), version: 1 }, null, 2)
  );
}

function header(step: number, total: number, title: string): void {
  const bar = `${c.dim}${"─".repeat(66)}${c.reset}`;
  console.log("");
  console.log(bar);
  console.log(
    `${c.bold}${c.blue}Step ${step}/${total}${c.reset}  ${c.bold}${title}${c.reset}`
  );
  console.log(bar);
}

function p(text: string): void {
  console.log(text);
}

async function ask(rl: Interface, prompt: string): Promise<string> {
  const answer = await rl.question(`${c.mauve}${prompt}${c.reset} `);
  return answer.trim();
}

async function pause(rl: Interface | null): Promise<void> {
  if (!rl) return;
  await rl.question(`${c.dim}(press Enter to continue, or ^C to quit)${c.reset} `);
}

async function readTokensFromConfig(): Promise<{
  github: boolean;
  linear: boolean;
}> {
  const result = { github: false, linear: false };
  const envPath = join(getRelayDir(), "config.env");
  try {
    const raw = await readFile(envPath, "utf8");
    const uncommented = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    // Treat an empty-value export as unset; only non-empty tokens count.
    if (/GITHUB_TOKEN=\s*["']?[^"'\s]+/.test(uncommented)) result.github = true;
    if (/LINEAR_API_KEY=\s*["']?[^"'\s]+/.test(uncommented)) result.linear = true;
  } catch {
    /* config.env absent — both stay false */
  }
  // Env vars set in the current shell also count.
  if (process.env.GITHUB_TOKEN) result.github = true;
  if (process.env.LINEAR_API_KEY || process.env.COMPOSIO_API_KEY) {
    result.linear = true;
  }
  return result;
}

export async function runWelcome(options: WelcomeOptions): Promise<number> {
  if (!options.reset && hasOnboarded()) {
    console.log(
      `${c.dim}You've already done the tour — run${c.reset} ${c.bold}rly welcome --reset${c.reset} ${c.dim}to see it again.${c.reset}`
    );
    return 0;
  }

  const rl = options.nonInteractive
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });

  try {
    const total = 6;

    // ── 1. Intro ─────────────────────────────────────────────────────────
    header(1, total, "What Relay is");
    p("");
    p(
      `${c.bold}Relay${c.reset} is a local-first orchestration layer for coding agents.`
    );
    p("It takes a request — a sentence, an issue URL, a vague idea — and:");
    p("");
    p(`  ${c.green}1.${c.reset} classifies the work (trivial / feature / architectural)`);
    p(`  ${c.green}2.${c.reset} decomposes it into parallel tickets with dependencies`);
    p(`  ${c.green}3.${c.reset} dispatches Claude / Codex per ticket with verification loops`);
    p(`  ${c.green}4.${c.reset} tracks PRs and turns CI-fail / review-requested into new tickets`);
    p("");
    p(`CLI: ${c.bold}rly${c.reset} (or the legacy ${c.dim}agent-harness${c.reset} alias)`);
    await pause(rl);

    // ── 2. Setup check ───────────────────────────────────────────────────
    header(2, total, "Setup check");
    const relayDir = getRelayDir();
    const configEnvPath = join(relayDir, CONFIG_ENV);
    const configEnvExists = existsSync(configEnvPath);
    const tokens = await readTokensFromConfig();
    const workspaces = await listRegisteredWorkspaces();

    const ok = (b: boolean) =>
      b ? `${c.green}✓${c.reset}` : `${c.peach}·${c.reset}`;

    p("");
    p(`  ${ok(configEnvExists)} ~/.relay/config.env ${configEnvExists ? "present" : "missing"}`);
    p(`  ${ok(tokens.github)} GITHUB_TOKEN      ${tokens.github ? "set" : "not set — PR watcher + GitHub issues disabled"}`);
    p(`  ${ok(tokens.linear)} LINEAR_API_KEY    ${tokens.linear ? "set" : "not set — Linear issue ingestion disabled"}`);
    p(
      `  ${ok(workspaces.length > 0)} repos registered  ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`
    );
    p("");

    // If config.env is missing, offer to scaffold it so the user doesn't
    // hit runtime errors later from a missing file. Interactive flows prompt;
    // non-interactive flows just print the cp command.
    if (!configEnvExists) {
      if (rl) {
        const answer = (
          await ask(
            rl,
            "No ~/.relay/config.env yet — copy the template into place now? [Y/n]"
          )
        ).toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") {
          const result = await scaffoldConfigEnv(relayDir);
          if (result.status === "created") {
            p(`  ${c.green}✓${c.reset} Created ${result.to}`);
            p(`    ${c.dim}Open it and fill in your tokens, then:${c.reset}`);
            p(`    source ~/.relay/config.env    ${c.dim}# or add to ~/.zshrc${c.reset}`);
          } else if (result.status === "already-exists") {
            p(`  ${c.dim}Already exists at ${result.path} — left untouched.${c.reset}`);
          } else {
            p(`  ${c.peach}!${c.reset} Template not found at ${result.expectedTemplate}.`);
            p(`    ${c.dim}Re-run install.sh to drop it in, or create config.env by hand.${c.reset}`);
          }
        } else {
          p(`  ${c.dim}Skipped — when you're ready, run:${c.reset}`);
          p(`    cp ~/.relay/config.env.template ~/.relay/config.env`);
        }
      } else {
        p(`  ${c.dim}To create it:${c.reset}`);
        p(`    cp ~/.relay/config.env.template ~/.relay/config.env`);
        p(`    ${c.dim}# fill in tokens${c.reset}`);
        p(`    source ~/.relay/config.env    ${c.dim}# or add to ~/.zshrc${c.reset}`);
      }
    } else if (!tokens.github) {
      p(`  ${c.dim}To enable GitHub/Linear, open${c.reset} ${c.bold}~/.relay/config.env${c.reset} ${c.dim}and fill in tokens, then:${c.reset}`);
      p(`    source ~/.relay/config.env    ${c.dim}# or add to ~/.zshrc${c.reset}`);
    }
    if (workspaces.length === 0) {
      p(`  ${c.dim}Register the current repo with${c.reset} ${c.bold}rly up${c.reset}`);
    }
    await pause(rl);

    // ── 3. Channels ──────────────────────────────────────────────────────
    header(3, total, "Channels");
    p("");
    p(`A ${c.bold}channel${c.reset} is a Slack-like space for one piece of work.`);
    p("Each channel carries:");
    p("");
    p(`  ${c.blue}feed${c.reset}     messages, status updates, PR transitions`);
    p(`  ${c.blue}tickets${c.reset}  parallelisable work units with dependency DAG`);
    p(`  ${c.blue}runs${c.reset}     classifier → planner → scheduler traces`);
    p(`  ${c.blue}decisions${c.reset}  recorded choices with rationale + alternatives`);
    p("");
    p(`List your channels:  ${c.bold}rly channels${c.reset}`);
    p(`Create one:          ${c.bold}rly channel create <name>${c.reset}`);
    p(`Show one:            ${c.bold}rly channel <id>${c.reset}`);
    await pause(rl);

    // ── 4. Sessions ──────────────────────────────────────────────────────
    header(4, total, "Sessions");
    p("");
    p(`A ${c.bold}session${c.reset} wraps your normal Claude or Codex CLI with the`);
    p("Relay MCP server attached. Everything the agent does flows through");
    p("Relay's tools — so channels, tickets, and decisions get recorded.");
    p("");
    p(`  ${c.bold}rly claude${c.reset}   launch Claude with Relay MCP`);
    p(`  ${c.bold}rly codex${c.reset}    launch Codex with Relay MCP`);
    p("");
    p(`${c.dim}Paste a GitHub or Linear issue URL as your ask and the classifier${c.reset}`);
    p(`${c.dim}auto-resolves it into a full plan with tickets.${c.reset}`);
    await pause(rl);

    // ── 5. Board + PR watcher ────────────────────────────────────────────
    header(5, total, "Board + PR watcher");
    p("");
    p(`The ${c.bold}board${c.reset} groups a channel's tickets by status: backlog,`);
    p("ready, executing, verifying, retry, blocked, completed, failed.");
    p("");
    p(`  ${c.bold}rly board <channelId>${c.reset}      kanban view in the terminal`);
    p(`  ${c.bold}rly tui${c.reset}                    ratatui dashboard (auto-builds)`);
    p(`  ${c.bold}rly gui${c.reset}                    Tauri desktop app (auto-builds)`);
    p("");
    p(`The ${c.bold}PR watcher${c.reset} is live whenever GITHUB_TOKEN is set. It polls`);
    p("every 30s and turns CI failures / change-requested reviews into new");
    p("follow-up tickets — so the scheduler keeps the loop closed.");
    p("");
    p(`  ${c.bold}rly pr-status${c.reset}              list currently tracked PRs`);
    p(`  ${c.bold}rly pr-watch <url>${c.reset}         manually track a PR`);
    await pause(rl);

    // ── 6. Power features + next steps ──────────────────────────────────
    header(6, total, "Going unattended + next steps");
    p("");
    p(`${c.bold}RELAY_AUTO_APPROVE=1${c.reset}   skip every permission prompt — Claude launches`);
    p(`                       with --dangerously-skip-permissions, Codex with`);
    p(`                       --full-auto. Required for multi-hour runs.`);
    p("");
    p(`${c.bold}RELAY_USE_DIST=1${c.reset}       run compiled dist (faster startup) instead of`);
    p(`                       live TS source. Default is live source via tsx.`);
    p("");
    p(`${c.bold}rly rebuild${c.reset}            rebuild dist / --tui / --gui / --all`);
    p(`${c.bold}rly doctor${c.reset}             diagnostics: paths, MCP wiring, tokens`);
    p(`${c.bold}rly crosslink status${c.reset}   active cross-session chatter`);
    p("");
    p(`${c.dim}Full reference:${c.reset} ${c.bold}docs/getting-started.md${c.reset}`);
    p(`${c.dim}Re-run this tour:${c.reset} ${c.bold}rly welcome --reset${c.reset}`);
    p("");

    if (rl) {
      const answer = (
        await ask(rl, "All set. Want me to run `rly doctor` now? [Y/n]")
      ).toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        p(`${c.dim}Run:${c.reset} rly doctor`);
      }
    }

    await markOnboarded();
    p("");
    p(`${c.green}✓${c.reset} Welcome tour done.`);
    p("");
    return 0;
  } finally {
    rl?.close();
  }
}
