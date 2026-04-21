import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration tests for `rly serve` flag validation and startup error paths.
 * Spawns the CLI via tsx (no build required) and asserts on the exit code +
 * stderr banner. These cover:
 *  - --host 0.0.0.0 with no token AND no --allow-unauthenticated-remote must refuse
 *  - EADDRINUSE produces a human-readable message, not a raw stack
 */

const here = fileURLToPath(import.meta.url);
const repoRoot = resolvePath(dirname(here), "..", "..");
const cliEntry = resolvePath(repoRoot, "src/cli.ts");
const tsxBin = resolvePath(repoRoot, "node_modules/.bin/tsx");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI and collect its output. We attach a kill-timer so a wayward
 * `rly serve` that actually starts successfully doesn't hang the test suite.
 */
function runCli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: opts.cwd ?? repoRoot,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 10_000);

    child.on("exit", (code) => {
      clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe("rly serve — flag validation", () => {
  let tmpRepo: string;

  beforeAll(async () => {
    // Workspace registry lookup walks up from cwd; run from a scratch dir that
    // won't match any registered workspace so the --workspace flag is required.
    tmpRepo = await mkdtemp(resolvePath(tmpdir(), "rly-serve-test-"));
  });

  afterAll(async () => {
    await rm(tmpRepo, { recursive: true, force: true });
  });

  it("refuses to start when binding non-loopback without --token or --allow-unauthenticated-remote", async () => {
    const result = await runCli(
      [
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--workspace",
        "test-workspace"
      ],
      { cwd: tmpRepo, env: { RELAY_TOKEN: "" } }
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to start/i);
    expect(result.stderr).toMatch(/--allow-unauthenticated-remote/);
  }, 15_000);
});

describe("rly serve — startup errors map to friendly messages", () => {
  let blocker: Server;
  let blockedPort = 0;

  beforeAll(async () => {
    // Bind a loopback port and hold it so the CLI attempt hits EADDRINUSE.
    blocker = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        const addr = blocker.address();
        blockedPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("EADDRINUSE — prints a clear 'port is already in use' message and exits 1", async () => {
    const result = await runCli(
      [
        "serve",
        "--port",
        String(blockedPort),
        "--workspace",
        "test-workspace"
      ],
      {
        // Point at a scratch cwd so workspace-registry fallback isn't the
        // error we trip on.
        cwd: tmpdir()
      }
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`Port ${blockedPort} is already in use`));
    expect(result.stderr).toMatch(/--port/);
  }, 15_000);
});
