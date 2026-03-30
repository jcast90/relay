import { spawn } from "node:child_process";

export async function launchInteractiveCommand(input: {
  command: "claude" | "codex";
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env
      },
      stdio: "inherit"
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
