import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandInvocation, CommandInvoker } from "../src/agents/command-invoker.js";
import { LocalArtifactStore } from "../src/execution/artifact-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";
import {
  selectVerificationCommands,
  VerificationRunner
} from "../src/execution/verification-runner.js";

describe("verification command selection", () => {
  it("filters proposed commands to the allowlist", () => {
    expect(
      selectVerificationCommands(
        ["pnpm test", "rm -rf /tmp/nope", "pnpm typecheck"],
        ["pnpm typecheck", "pnpm test"]
      )
    ).toEqual({
      commandsToRun: ["pnpm test", "pnpm typecheck"],
      rejected: ["rm -rf /tmp/nope"],
      overridden: false
    });
  });

  it("falls back to allowlisted commands when tester proposes none", () => {
    expect(selectVerificationCommands([], ["pnpm typecheck"])).toEqual({
      commandsToRun: ["pnpm typecheck"],
      rejected: [],
      overridden: false
    });
  });
});

describe("verification runner", () => {
  it("captures command results as artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "agent-harness-artifacts-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "agent-harness-artifacts-hs-"));
    const artifactStore = new LocalArtifactStore(artifactRoot, new FileHarnessStore(storeRoot));
    const runner = new VerificationRunner(
      new FakeCommandInvoker(),
      artifactStore
    );

    try {
      const execution = await runner.executeCommand({
        runId: "run-1",
        phaseId: "phase-1",
        repoRoot: process.cwd(),
        command: "pnpm typecheck"
      });

      const file = await artifactStore.readCommandResult(execution.artifact.path);

      expect(execution.result.exitCode).toBe(0);
      expect(execution.artifact.type).toBe("command_result");
      expect(file.command).toBe("pnpm typecheck");
      expect(file.exitCode).toBe(0);
      expect(file.stdout).toContain("simulated");
    } finally {
      await rm(artifactRoot, {
        recursive: true,
        force: true
      });
      await rm(storeRoot, {
        recursive: true,
        force: true
      });
    }
  });
});

class FakeCommandInvoker implements CommandInvoker {
  async exec(invocation: CommandInvocation) {
    return {
      stdout: `simulated ${invocation.args.join(" ")}`,
      stderr: "",
      exitCode: 0
    };
  }
}
