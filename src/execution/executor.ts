import type { TicketDefinition } from "../domain/ticket.js";
import type { SandboxRef } from "./sandbox.js";

export interface ExecutorStartOptions {
  runId: string;
  repoRoot: string;
  sandbox: SandboxRef;
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
  data?: string;
}

export interface ExecutionHandle {
  readonly id: string;
  readonly sandbox: SandboxRef;
  wait(): Promise<ExecutionResult>;
  // Async so remote executors (pod, VM) can make a network call to terminate.
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  // Pull-based so the scheduler can back-pressure and the executor can bridge
  // to SSE/WebSocket later without redesigning the surface. Separate from
  // wait() so a consumer can take either independently.
  stream(): AsyncIterable<ExecutionEvent>;
}

export interface AgentExecutor {
  /** Start work on a ticket. Returns a handle the scheduler can wait/kill/stream on. */
  start(ticket: TicketDefinition, opts: ExecutorStartOptions): Promise<ExecutionHandle>;
}
