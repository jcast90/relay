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
      agent_harness: {
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
          AGENT_HARNESS_RUNS_INDEX: input.paths.runsIndexPath
        }
      }
    }
  };

  await writeFile(path, JSON.stringify(config, null, 2));

  return path;
}

export function buildClaudeLaunchArgs(input: {
  userArgs: string[];
  mcpConfigPath: string;
}): string[] {
  return [
    "--mcp-config",
    input.mcpConfigPath,
    "--append-system-prompt",
    "Agent Harness MCP is attached as server agent_harness. Use it to inspect workspace status, recent runs, phase ledgers, and artifacts before deciding how to proceed.",
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
    `mcp_servers.agent_harness.command=${tomlString(process.execPath)}`,
    "-c",
    `mcp_servers.agent_harness.args=${tomlArray([
      input.cliEntrypoint,
      "mcp-server",
      "--workspace",
      input.cwd
    ])}`,
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
