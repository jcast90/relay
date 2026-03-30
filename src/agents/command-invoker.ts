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

export interface CommandInvoker {
  exec(invocation: CommandInvocation): Promise<CommandResult>;
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
}
