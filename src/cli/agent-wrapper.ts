import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessWorkspacePaths } from "./workspace.js";

export async function ensureClaudeMcpConfig(input: {
  cwd: string;
  cliEntrypoint: string;
  paths: HarnessWorkspacePaths;
}): Promise<string> {
  await mkdir(input.paths.rootDir, {
    recursive: true
  });

  const path = join(input.paths.rootDir, "claude.mcp.json");
  const config = {
    mcpServers: {
      relay: {
        command: process.execPath,
        args: [
          input.cliEntrypoint,
          "mcp-server",
          "--workspace",
          input.cwd
        ],
        env: {
          RELAY_HOME: input.paths.rootDir,
          RELAY_ARTIFACTS_DIR: input.paths.artifactsDir,
          RELAY_RUNS_INDEX: input.paths.runsIndexPath,
          RELAY_PROVIDER: "claude"
        }
      }
    }
  };

  await writeFile(path, JSON.stringify(config, null, 2));

  return path;
}

const HARNESS_SYSTEM_PROMPT = [
  "Relay MCP is attached as server relay. Use it to inspect workspace status, recent runs, phase ledgers, and artifacts before deciding how to proceed.",
  "",
  "CROSSLINK: You have cross-session collaboration tools. Other agent sessions in different repos may be running simultaneously.",
  "- crosslink_discover: Find other active sessions and their repos/capabilities.",
  "- crosslink_send: Send a question or message to another session.",
  "- crosslink_poll: Check for inbound messages from other sessions.",
  "- crosslink_reply: Reply to an inbound message.",
  "- crosslink_register: Update your session description so others know what you're working on.",
  "",
  "When you receive a crosslink message (prefixed with [CROSSLINK INBOUND]), read it carefully and use crosslink_reply to respond.",
  "If you need information from another repo, use crosslink_discover to find the right session, then crosslink_send to ask."
].join("\n");

/**
 * Auto-approve is enabled when RELAY_AUTO_APPROVE=1 OR the user passed
 * --auto-approve / --yolo. Reads from env so children inherit.
 */
export function isAutoApproveEnabled(args: string[] = []): boolean {
  if (args.includes("--auto-approve") || args.includes("--yolo")) return true;
  const env = process.env.RELAY_AUTO_APPROVE;
  return env === "1" || env === "true" || env === "yes";
}

/**
 * Strip our own auto-approve flags so they don't get passed through to the
 * underlying CLI (which wouldn't recognise them).
 */
export function stripAutoApproveFlags(args: string[]): string[] {
  return args.filter((arg) => arg !== "--auto-approve" && arg !== "--yolo");
}

export function buildClaudeLaunchArgs(input: {
  userArgs: string[];
  mcpConfigPath: string;
  autoApprove?: boolean;
}): string[] {
  const base = [
    "--mcp-config",
    input.mcpConfigPath,
    "--append-system-prompt",
    HARNESS_SYSTEM_PROMPT
  ];
  if (input.autoApprove) {
    // Claude Code's flag for unattended runs. No per-tool prompts.
    base.push("--dangerously-skip-permissions");
  }
  return [...base, ...input.userArgs];
}

export function buildCodexLaunchArgs(input: {
  userArgs: string[];
  cwd: string;
  cliEntrypoint: string;
  autoApprove?: boolean;
}): string[] {
  const base = [
    "-c",
    `mcp_servers.relay.command=${tomlString(process.execPath)}`,
    "-c",
    `mcp_servers.relay.args=${tomlArray([
      input.cliEntrypoint,
      "mcp-server",
      "--workspace",
      input.cwd
    ])}`,
    "-c",
    `mcp_servers.relay.env.RELAY_PROVIDER=${tomlString("codex")}`
  ];
  if (input.autoApprove) {
    // Codex CLI's unattended mode. If your codex version rejects this flag,
    // drop auto-approve or set --approval-policy never manually.
    base.push("--full-auto");
  }
  return [...base, ...input.userArgs];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

export function hasHarnessMcpOptOut(args: string[]): boolean {
  return args.includes("--no-harness-mcp");
}

export function stripHarnessMcpOptOut(args: string[]): string[] {
  return args.filter((arg) => arg !== "--no-harness-mcp");
}
