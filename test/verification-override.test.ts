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

describe("selectVerificationCommands override signal", () => {
  it("flags override=true when all proposed commands are rejected", () => {
    const result = selectVerificationCommands(
      ["rm -rf /tmp/nope", "curl evil.com"],
      ["pnpm test", "pnpm typecheck"]
    );
    expect(result.overridden).toBe(true);
    expect(result.commandsToRun).toEqual(["pnpm test", "pnpm typecheck"]);
    expect(result.rejected).toEqual(["rm -rf /tmp/nope", "curl evil.com"]);
  });

  it("flags override=false when at least one proposed command is approved", () => {
    const result = selectVerificationCommands(
      ["pnpm test", "rm -rf /tmp/nope"],
      ["pnpm test", "pnpm typecheck"]
    );
    expect(result.overridden).toBe(false);
    expect(result.commandsToRun).toEqual(["pnpm test"]);
    expect(result.rejected).toEqual(["rm -rf /tmp/nope"]);
  });

  it("flags override=false when the agent proposed nothing (default path)", () => {
    const result = selectVerificationCommands([], ["pnpm typecheck"]);
    expect(result.overridden).toBe(false);
    expect(result.commandsToRun).toEqual(["pnpm typecheck"]);
    expect(result.rejected).toEqual([]);
  });
});

describe("VerificationRunner surfaces override in run() result", () => {
  it("marks overridden=true and records substitutedCommands when the agent's proposals are rejected", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "ver-override-art-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "ver-override-hs-"));
    const artifactStore = new LocalArtifactStore(
      artifactRoot,
      new FileHarnessStore(storeRoot)
    );
    const runner = new VerificationRunner(new FakeCommandInvoker(), artifactStore);

    try {
      const result = await runner.run({
        runId: "run-override",
        phaseId: "phase-1",
        repoRoot: process.cwd(),
        proposedCommands: ["rm -rf /tmp/nope"],
        allowlistedCommands: ["pnpm test", "pnpm typecheck"]
      });

      expect(result.overridden).toBe(true);
      expect(result.substitutedCommands).toEqual(["pnpm test", "pnpm typecheck"]);
      expect(result.rejected).toEqual(["rm -rf /tmp/nope"]);
      expect(result.success).toBe(true);
      expect(result.executed).toHaveLength(2);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("keeps overridden=false and substitutedCommands empty on the happy path", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "ver-override-art-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "ver-override-hs-"));
    const artifactStore = new LocalArtifactStore(
      artifactRoot,
      new FileHarnessStore(storeRoot)
    );
    const runner = new VerificationRunner(new FakeCommandInvoker(), artifactStore);

    try {
      const result = await runner.run({
        runId: "run-clean",
        phaseId: "phase-1",
        repoRoot: process.cwd(),
        proposedCommands: ["pnpm test"],
        allowlistedCommands: ["pnpm test", "pnpm typecheck"]
      });

      expect(result.overridden).toBe(false);
      expect(result.substitutedCommands).toEqual([]);
      expect(result.rejected).toEqual([]);
      expect(result.success).toBe(true);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
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
