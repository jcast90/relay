import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildClaudeLaunchArgs,
  buildCodexLaunchArgs,
  ensureClaudeMcpConfig,
  hasHarnessMcpOptOut,
  stripHarnessMcpOptOut,
} from "../src/cli/agent-wrapper.js";
import { getHarnessWorkspacePaths } from "../src/cli/workspace.js";

describe("agent wrapper", () => {
  it("writes a Claude MCP config that points back to the harness CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-harness-wrapper-"));
    const paths = getHarnessWorkspacePaths(cwd);

    try {
      const configPath = await ensureClaudeMcpConfig({
        cwd,
        cliEntrypoint: "/tmp/agent-harness/dist/cli.js",
        paths,
      });
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        mcpServers: {
          relay: {
            command: string;
            args: string[];
            env: Record<string, string>;
          };
        };
      };

      expect(configPath).toContain("claude.mcp.json");
      expect(config.mcpServers.relay.command).toBe(process.execPath);
      expect(config.mcpServers.relay.args).toEqual([
        "/tmp/agent-harness/dist/cli.js",
        "mcp-server",
        "--workspace",
        cwd,
      ]);
      expect(config.mcpServers.relay.env.AGENT_HARNESS_HOME).toBe(paths.rootDir);
      expect(config.mcpServers.relay.env.AGENT_HARNESS_RUNS_INDEX).toBe(paths.runsIndexPath);
    } finally {
      await rm(cwd, {
        recursive: true,
        force: true,
      });
    }
  });

  it("builds launch arguments that auto-attach MCP to Claude and Codex", () => {
    const claudeArgs = buildClaudeLaunchArgs({
      userArgs: ["--help"],
      mcpConfigPath: "/tmp/claude.mcp.json",
    });
    const codexArgs = buildCodexLaunchArgs({
      userArgs: ["--help"],
      cwd: "/tmp/workspace",
      cliEntrypoint: "/tmp/agent-harness/dist/cli.js",
    });

    expect(claudeArgs).toContain("--mcp-config");
    expect(claudeArgs).toContain("/tmp/claude.mcp.json");
    expect(claudeArgs).not.toContain("--strict-mcp-config");
    expect(claudeArgs).toContain("--append-system-prompt");
    expect(claudeArgs.at(-1)).toBe("--help");

    expect(codexArgs).toContain("-c");
    expect(codexArgs).toContain(`mcp_servers.relay.command=${JSON.stringify(process.execPath)}`);
    expect(codexArgs).toContain(
      'mcp_servers.relay.args=["/tmp/agent-harness/dist/cli.js","mcp-server","--workspace","/tmp/workspace"]'
    );
    expect(codexArgs.at(-1)).toBe("--help");
  });

  it("supports opting out of harness MCP attachment", () => {
    expect(hasHarnessMcpOptOut(["--no-harness-mcp", "--help"])).toBe(true);
    expect(hasHarnessMcpOptOut(["--help"])).toBe(false);
    expect(stripHarnessMcpOptOut(["--no-harness-mcp", "--help"])).toEqual(["--help"]);
  });
});
