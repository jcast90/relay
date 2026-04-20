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
          AGENT_HARNESS_HOME: input.paths.rootDir,
          AGENT_HARNESS_ARTIFACTS_DIR: input.paths.artifactsDir,
          AGENT_HARNESS_RUNS_INDEX: input.paths.runsIndexPath,
          AGENT_HARNESS_PROVIDER: "claude"
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

export function buildClaudeLaunchArgs(input: {
  userArgs: string[];
  mcpConfigPath: string;
}): string[] {
  return [
    "--mcp-config",
    input.mcpConfigPath,
    "--append-system-prompt",
    HARNESS_SYSTEM_PROMPT,
    ...input.userArgs
  ];
}

export function buildCodexLaunchArgs(input: {
  userArgs: string[];
  cwd: string;
  cliEntrypoint: string;
}): string[] {
  return [
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
    `mcp_servers.relay.env.AGENT_HARNESS_PROVIDER=${tomlString("codex")}`,
    ...input.userArgs
  ];
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
