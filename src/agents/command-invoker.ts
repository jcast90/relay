import { spawn } from "node:child_process";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Live handle to a spawned child process — the streaming counterpart of
 * {@link CommandResult}. Consumers subscribe to stdout/stderr/exit via the
 * provided listener registrations and terminate via {@link kill}.
 *
 * Separate from {@link CommandResult} so executors (T-202
 * LocalChildProcessExecutor) can stream events without bouncing through a
 * buffered Promise — the event boundary stays thin.
 */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** Subscribe to stdout chunks as the child emits them. */
  onStdout(listener: (chunk: string) => void): void;
  /** Subscribe to stderr chunks as the child emits them. */
  onStderr(listener: (chunk: string) => void): void;
  /** Fires exactly once when the child exits (code/signal per Node semantics). */
  onExit(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void
  ): void;
  /** Fires when the spawn itself fails (e.g. ENOENT for a missing binary). */
  onError(listener: (error: Error) => void): void;
  /**
   * Send a signal to the child. Returns `false` if the process has already
   * exited — mirroring `ChildProcess.kill`'s documented contract.
   */
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CommandInvoker {
  exec(invocation: CommandInvocation): Promise<CommandResult>;
  /**
   * Streaming spawn. Returns immediately with a live handle — callers wire up
   * listeners and decide when to wait or kill.
   *
   * Optional on the interface so historical test fakes (e.g. ScriptedInvoker,
   * which only needs the buffered `exec` path) don't have to implement a
   * streaming codepath they never exercise. `LocalChildProcessExecutor` checks
   * for `spawn` at construction time and throws if the injected invoker is
   * not streaming-capable.
   */
  spawn?(invocation: CommandInvocation): SpawnedProcess;
}

export class NodeCommandInvoker implements CommandInvoker {
  async exec(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(
        invocation.command,
        invocation.args,
        {
        cwd: invocation.cwd,
        env: {
          ...process.env,
          ...invocation.env
        },
        stdio: "pipe"
        }
      );

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, invocation.timeoutMs ?? 300_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);

        if (timedOut) {
          reject(new Error(`Command timed out: ${invocation.command}`));
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1
        });
      });

      if (invocation.stdin) {
        child.stdin.write(invocation.stdin);
      }

      child.stdin.end();
    });
  }

  /**
   * Streaming spawn used by `LocalChildProcessExecutor`. Returns a thin
   * adapter over Node's {@link ChildProcessWithoutNullStreams} — listener
   * registration maps 1:1 onto the underlying process events, and `kill`
   * delegates to `ChildProcess.kill` (whose falsy return for already-exited
   * processes we preserve so callers can detect double-kill as a no-op).
   *
   * Timeout enforcement lives in the executor, not here, because the
   * escalation policy (SIGTERM → 2s grace → SIGKILL with exit 124) is
   * executor-level behavior and we don't want two parties racing to kill the
   * same child.
   */
  spawn(invocation: CommandInvocation): SpawnedProcess {
    const child: ChildProcessWithoutNullStreams = spawn(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        env: {
          ...process.env,
          ...invocation.env
        },
        stdio: "pipe"
      }
    );

    if (invocation.stdin) {
      child.stdin.write(invocation.stdin);
    }
    child.stdin.end();

    return {
      pid: child.pid,
      onStdout(listener) {
        child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString()));
      },
      onStderr(listener) {
        child.stderr.on("data", (chunk: Buffer) => listener(chunk.toString()));
      },
      onExit(listener) {
        // `close` (not `exit`) so stdio streams are fully flushed before the
        // listener fires — prevents losing trailing stdout when a consumer
        // drops the process the moment exit fires.
        child.on("close", (code, signal) => listener(code, signal));
      },
      onError(listener) {
        child.on("error", listener);
      },
      kill(signal) {
        return child.kill(signal);
      }
    };
  }
}
