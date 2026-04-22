import { spawn } from "node:child_process";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  /**
   * Explicit key/value overrides layered on top of the sanitized parent env.
   * Keys here are NOT filtered by the secret regex — the caller has made an
   * explicit decision to set them. Use this for values the caller synthesizes
   * (e.g. `AGENT_HARNESS_HOME`, per-invocation overlays).
   */
  env?: Record<string, string | undefined>;
  /**
   * Parent-env variable names to forward into the child. The sanitizer strips
   * everything not on the default whitelist by default — including
   * `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, AWS creds, etc. Callers that
   * legitimately need a secret forwarded (e.g. a claude/codex CLI that reads
   * `ANTHROPIC_API_KEY`, a subprocess that calls `gh` via `GITHUB_TOKEN`)
   * opt-in per-name here.
   *
   * Values are copied from `process.env` at spawn time. Names not present in
   * `process.env` are silently skipped.
   */
  passEnv?: string[];
}

/**
 * Exact-match env vars the sanitizer always forwards from the parent process.
 * Kept conservative — if a subprocess needs more, route it through
 * {@link CommandInvocation.passEnv} or {@link CommandInvocation.env}.
 */
export const DEFAULT_ENV_WHITELIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "PWD",
  "NODE_ENV",
]);

/**
 * Prefix families whose members are forwarded verbatim. `LC_*` covers the
 * full locale family; `HARNESS_*` / `RELAY_*` / `AGENT_HARNESS_*` are the
 * harness's own namespace for wiring workspace paths + feature flags into
 * dispatched subprocesses.
 */
const DEFAULT_PREFIX_WHITELIST: readonly string[] = ["LC_", "HARNESS_", "RELAY_", "AGENT_HARNESS_"];

/**
 * Matches env var names that look like credentials. Covers suffix forms
 * (`FOO_TOKEN`, `API_KEY`) and prefix forms (`TOKEN_FOO`, `KEY_BAR`). Used as
 * a second-pass filter so a well-meaning addition to the whitelist can't
 * accidentally leak a secret — the strip pass runs after the allow pass.
 *
 * The word list covers both the conventional `_`-separated forms (`API_KEY`,
 * `ACCESS_TOKEN`) and the concatenated forms that show up in the wild
 * (`APIKEY`, `ACCESSTOKEN`, `PRIVATEKEY`, `BEARERTOKEN`, …). Longer
 * alternatives are listed before shorter ones so regex alternation prefers
 * the more specific match (standard left-to-right alternation semantics).
 */
const SECRET_NAME_PATTERN =
  /(?:^|_)(APIKEY|PRIVATEKEY|SESSIONKEY|ENCRYPTKEY|SIGNINGKEY|ACCESSTOKEN|REFRESHTOKEN|IDTOKEN|BEARERTOKEN|BEARER|JWT|OAUTH|TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDS|AUTH)S?(?:_|$)/i;

/** True if the variable name looks credential-shaped. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

export interface SanitizeEnvOptions {
  /**
   * Extra env-var names to forward from the parent process, in addition to
   * {@link DEFAULT_ENV_WHITELIST}. These bypass the secret filter — use only
   * for values the caller explicitly needs (e.g. `ANTHROPIC_API_KEY`).
   */
  passEnv?: string[];
  /**
   * Explicit key/value overrides layered on top of the sanitized parent env.
   * These bypass the secret filter — the caller has made an explicit
   * decision to set them.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Build the env map for a spawned subprocess.
 *
 *   1. Start from the default whitelist (plus the `*_` prefix families).
 *   2. Add anything named in `opts.passEnv` that exists in `parentEnv`.
 *   3. Strip any key matching the secret regex that wasn't explicitly
 *      allowlisted via `passEnv` or `env` — defense in depth against
 *      whitelist mistakes.
 *   4. Layer `opts.env` on top (explicit overrides, not filtered).
 *
 * Returns a fresh object with no references back into `parentEnv`.
 */
export function sanitizeEnv(
  parentEnv: NodeJS.ProcessEnv,
  opts: SanitizeEnvOptions = {}
): Record<string, string> {
  const passEnvSet = new Set(opts.passEnv ?? []);
  const explicitKeys = new Set<string>([...passEnvSet, ...Object.keys(opts.env ?? {})]);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;

    const isAllowlisted =
      DEFAULT_ENV_WHITELIST.has(key) ||
      DEFAULT_PREFIX_WHITELIST.some((prefix) => key.startsWith(prefix)) ||
      passEnvSet.has(key);

    if (!isAllowlisted) continue;

    // Second pass: strip anything secret-shaped unless the caller explicitly
    // asked for it. Belt-and-suspenders against a careless addition to the
    // whitelist.
    if (SECRET_NAME_PATTERN.test(key) && !explicitKeys.has(key)) continue;

    result[key] = value;
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) {
        delete result[key];
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

function buildChildEnv(invocation: CommandInvocation): Record<string, string> {
  return sanitizeEnv(process.env, {
    passEnv: invocation.passEnv,
    env: invocation.env,
  });
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
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
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

/**
 * Default {@link CommandInvoker}. Every spawned child receives a sanitized
 * environment — see {@link sanitizeEnv}. The parent process's secrets are
 * NOT inherited by default; callers that need `ANTHROPIC_API_KEY`,
 * `GITHUB_TOKEN`, etc. opt-in per-invocation via
 * {@link CommandInvocation.passEnv} (pull by name from `process.env`) or
 * {@link CommandInvocation.env} (explicit key/value).
 */
export class NodeCommandInvoker implements CommandInvoker {
  async exec(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: buildChildEnv(invocation),
        stdio: "pipe",
      });

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
          exitCode: code ?? 1,
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
    const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: buildChildEnv(invocation),
      stdio: "pipe",
    });

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
      },
    };
  }
}
