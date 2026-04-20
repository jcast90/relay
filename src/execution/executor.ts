import type { TicketDefinition } from "../domain/ticket.js";
import type { SandboxRef } from "./sandbox.js";

export interface ExecutorStartOptions {
  runId: string;
  repoRoot: string;
  /**
   * Pre-built sandbox to execute inside. Optional so executors that manage
   * their own sandbox lifecycle (see `LocalChildProcessExecutor` with a
   * `sandboxProvider`) can create one per `start()` call without the caller
   * having to fabricate a ref. Executors that don't create sandboxes must
   * throw a clear error if this field is missing.
   */
  sandbox?: SandboxRef;
  /** Optional per-invocation timeout, in ms. Executors enforce via kill(). */
  timeoutMs?: number;
  /** Forwarded to the process environment where applicable. */
  env?: Record<string, string | undefined>;
}

export interface ExecutionResult {
  exitCode: number;
  summary?: string;
  stdout: string;
  stderr: string;
}

export type ExecutionEventKind =
  | "start"
  | "stdout"
  | "stderr"
  | "tool_use"
  | "heartbeat"
  | "exit";

export interface ExecutionEvent {
  kind: ExecutionEventKind;
  at: string; // ISO-8601
  /**
   * Event payload. Shape varies by `kind`:
   *   - `stdout` / `stderr`: string (line or chunk)
   *   - `tool_use`: structured record (tool name, args, id)
   *   - `exit`: string exit code or small summary object
   *   - `start` / `heartbeat`: typically omitted
   * Kept as `unknown` so structured payloads don't need to be stringified at
   * the event boundary; consumers narrow on `kind`.
   */
  data?: unknown;
}

/**
 * Lifecycle state of an ExecutionHandle.
 * - `running`: handle is live; wait() has not resolved and kill() has not been called.
 * - `exited`:  wait() has resolved with the process's own exit code.
 * - `killed`:  kill() was called before wait() resolved; next wait() yields exitCode 137.
 */
export type ExecutionStatus = "running" | "exited" | "killed";

export interface ExecutionHandle {
  readonly id: string;
  readonly sandbox: SandboxRef;
  /**
   * Observational status of the handle. Callers may poll it between awaits
   * (e.g. for dashboards or scheduler decisions), but it is only authoritative
   * once {@link ExecutionHandle.wait} has resolved — before that it is a best-
   * effort snapshot that can race with in-flight I/O in real executor impls.
   */
  readonly status: ExecutionStatus;
  wait(): Promise<ExecutionResult>;
  /**
   * Terminate the underlying execution.
   *
   * Idempotent. Calling `kill()` after `wait()` has resolved is a no-op — the
   * exit code is already cached and the handle's `status` stays `exited`.
   * Calling `kill()` before `wait()` transitions the handle to `killed`; the
   * next `wait()` resolves with `exitCode: 137` (128 + SIGKILL). Double-kill
   * is safe: the second call is a no-op.
   *
   * Async so remote executors (pod, VM) can make a network call to terminate.
   */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /**
   * Live, single-consumer event stream.
   *
   * Iteration begins at subscribe time — there is **no replay** of events
   * emitted before subscription. For a handle that has already completed,
   * `stream()` yields the terminal events (`start`, `exit`) synthesized from
   * cached state so late subscribers still see a coherent begin/end pair.
   *
   * Calling `stream()` twice is supported: each call returns an independent
   * iterator. Do **not** rely on identical ordering across calls on a
   * still-running handle — the two iterators race each other against a live
   * producer. On a completed handle both iterators yield the same synthesized
   * start+exit pair.
   *
   * Pull-based so the scheduler can back-pressure and the executor can bridge
   * to SSE/WebSocket later without redesigning the surface. Separate from
   * wait() so a consumer can take either independently.
   */
  stream(): AsyncIterable<ExecutionEvent>;
}

export interface AgentExecutor {
  /** Start work on a ticket. Returns a handle the scheduler can wait/kill/stream on. */
  start(ticket: TicketDefinition, opts: ExecutorStartOptions): Promise<ExecutionHandle>;
}
