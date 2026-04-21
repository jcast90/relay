// Composition wiring (HARNESS_EXECUTOR=pod env selection into orchestrator-v2)
// is a follow-up PR. This file ships the executor + sandbox provider impl.

import { PassThrough, Writable } from "node:stream";

import type { TicketDefinition } from "../domain/ticket.js";
import type {
  AgentExecutor,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ExecutorStartOptions
} from "./executor.js";
import type { SandboxRef } from "./sandbox.js";
import type { K8sClientLike, K8sJob } from "./k8s-client.js";
import type { PVCSandboxProvider } from "./sandboxes/pvc-sandbox.js";

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_TERMINATION_GRACE_S = 10;
const KILLED_EXIT_CODE = 137;
const JOB_FAILED_EXIT_CODE = 1;
const SUMMARY_PREFIX_LENGTH = 120;

export interface PodResourceRequests {
  cpu?: string;
  memory?: string;
}

export interface PodExecutorOptions {
  sandboxProvider: PVCSandboxProvider;
  k8sClient: K8sClientLike;
  namespace: string;
  workerImage: string;
  imagePullSecrets?: string[];
  serviceAccountName?: string;
  resources?: { requests?: PodResourceRequests; limits?: PodResourceRequests };
  pollIntervalMs?: number;
  /**
   * Max time after kill() before we synthesize an exit. Mirrors the
   * LocalChildProcessExecutor's post-kill watchdog so wait() can never hang.
   */
  postKillWatchdogMs?: number;
  /**
   * If false, the executor polls readPodLog in chunks instead of using
   * streamPodLog. Useful when the client doesn't implement streaming.
   */
  useStreamingLogs?: boolean;
}

interface ParsedRemoteUri {
  namespace: string;
  pvcName: string;
  mountPath: string;
}

function parsePodUri(uri: string): ParsedRemoteUri {
  const match = /^pod:\/\/([^/]+)\/([^:]+):(.+)$/.exec(uri);
  if (!match) {
    throw new Error(
      `PodExecutor requires a sandbox URI like pod://<ns>/<pvc>:/work; got ${uri}`
    );
  }
  return { namespace: match[1], pvcName: match[2], mountPath: match[3] };
}

function buildJobManifest(opts: {
  jobName: string;
  namespace: string;
  pvcName: string;
  mountPath: string;
  workerImage: string;
  imagePullSecrets?: string[];
  serviceAccountName?: string;
  env: Array<{ name: string; value: string }>;
  resources?: PodExecutorOptions["resources"];
  labels: Record<string, string>;
  terminationGracePeriodSeconds: number;
}): K8sJob {
  const containerResources: Record<string, unknown> = {};
  if (opts.resources?.requests) containerResources.requests = opts.resources.requests;
  if (opts.resources?.limits) containerResources.limits = opts.resources.limits;

  return {
    metadata: { name: opts.jobName, namespace: opts.namespace, labels: opts.labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: opts.labels },
        spec: {
          restartPolicy: "Never",
          terminationGracePeriodSeconds: opts.terminationGracePeriodSeconds,
          ...(opts.serviceAccountName
            ? { serviceAccountName: opts.serviceAccountName }
            : {}),
          ...(opts.imagePullSecrets && opts.imagePullSecrets.length > 0
            ? { imagePullSecrets: opts.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          containers: [
            {
              name: "worker",
              image: opts.workerImage,
              workingDir: opts.mountPath,
              env: opts.env,
              ...(Object.keys(containerResources).length > 0
                ? { resources: containerResources }
                : {}),
              volumeMounts: [{ name: "work", mountPath: opts.mountPath }]
            }
          ],
          volumes: [
            {
              name: "work",
              persistentVolumeClaim: { claimName: opts.pvcName }
            }
          ]
        }
      }
    }
  };
}

class EventBus {
  private readonly subscribers = new Set<(event: ExecutionEvent, terminal: boolean) => void>();
  private cachedStart: ExecutionEvent | null = null;
  private cachedExit: ExecutionEvent | null = null;

  emit(event: ExecutionEvent, terminal = false): void {
    if (event.kind === "start") this.cachedStart = event;
    else if (event.kind === "exit") this.cachedExit = event;
    for (const sub of this.subscribers) sub(event, terminal);
  }

  subscribe(onEvent: (event: ExecutionEvent, terminal: boolean) => void): () => void {
    this.subscribers.add(onEvent);
    return () => {
      this.subscribers.delete(onEvent);
    };
  }

  get completed(): boolean {
    return this.cachedExit !== null;
  }
  get cache(): { start: ExecutionEvent | null; exit: ExecutionEvent | null } {
    return { start: this.cachedStart, exit: this.cachedExit };
  }
}

interface PodHandleDeps {
  id: string;
  sandbox: SandboxRef;
  namespace: string;
  jobName: string;
  client: K8sClientLike;
  pollIntervalMs: number;
  postKillWatchdogMs: number;
  timeoutMs?: number;
  useStreamingLogs: boolean;
}

class PodExecutionHandle implements ExecutionHandle {
  readonly id: string;
  readonly sandbox: SandboxRef;

  private readonly bus = new EventBus();
  private readonly deps: PodHandleDeps;
  private cachedResult: ExecutionResult | null = null;
  private waitPromise: Promise<ExecutionResult> | null = null;
  private killRequested = false;
  private timedOut = false;
  private logAborter: AbortController | null = null;
  private logPollTimer: NodeJS.Timeout | null = null;
  private logSinceSeconds = 0;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private postKillTimer: NodeJS.Timeout | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private podName: string | null = null;

  constructor(deps: PodHandleDeps) {
    this.id = deps.id;
    this.sandbox = deps.sandbox;
    this.deps = deps;
    this.bus.emit({ kind: "start", at: new Date().toISOString() });
    this.armTimeout();
  }

  get status(): ExecutionStatus {
    if (this.cachedResult) {
      return this.killRequested && this.cachedResult.exitCode === KILLED_EXIT_CODE
        ? "killed"
        : "exited";
    }
    return this.killRequested ? "killed" : "running";
  }

  wait(): Promise<ExecutionResult> {
    if (!this.waitPromise) {
      this.waitPromise = this.runWait();
    }
    return this.waitPromise;
  }

  async kill(_signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    if (this.cachedResult) return;
    this.killRequested = true;
    this.armPostKillWatchdog();
    this.stopLogStream();
    const podNames = await this.resolvePodNames().catch(() => [] as string[]);
    for (const name of podNames) {
      await this.deps.client
        .deletePod(this.deps.namespace, name, { gracePeriodSeconds: 5 })
        .catch(() => undefined);
    }
    await this.deps.client
      .deleteJob(this.deps.namespace, this.deps.jobName, {
        propagationPolicy: "Background"
      })
      .catch(() => undefined);
  }

  async *stream(): AsyncIterable<ExecutionEvent> {
    if (this.bus.completed) {
      const { start, exit } = this.bus.cache;
      if (start) yield start;
      if (exit) yield exit;
      return;
    }
    const queue: Array<{ event: ExecutionEvent; terminal: boolean }> = [];
    let resolver: (() => void) | null = null;
    const unsubscribe = this.bus.subscribe((event, terminal) => {
      queue.push({ event, terminal });
      resolver?.();
      resolver = null;
    });
    const cachedStart = this.bus.cache.start;
    if (cachedStart) yield cachedStart;
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
        }
        const next = queue.shift();
        if (!next) continue;
        if (next.event.kind === "start" && cachedStart) continue;
        yield next.event;
        if (next.terminal) return;
      }
    } finally {
      unsubscribe();
    }
  }

  private async runWait(): Promise<ExecutionResult> {
    const deadline = this.deps.timeoutMs
      ? Date.now() + this.deps.timeoutMs
      : Number.POSITIVE_INFINITY;
    this.pokeLogStream().catch(() => undefined);

    while (!this.cachedResult) {
      if (Date.now() >= deadline && !this.timedOut) {
        this.timedOut = true;
        await this.kill("SIGTERM");
      }
      const job = await this.deps.client.readJob(this.deps.namespace, this.deps.jobName);
      if (!job) {
        this.finalize(this.killRequested ? KILLED_EXIT_CODE : JOB_FAILED_EXIT_CODE, "job missing");
        break;
      }
      const status = job.status ?? {};
      if (this.podName === null) {
        await this.pokeLogStream().catch(() => undefined);
      }
      if (status.succeeded && status.succeeded > 0) {
        await this.finalizeFromPodLogs(0);
        break;
      }
      if (status.failed && status.failed > 0) {
        const exitCode = await this.resolveFailureExitCode();
        await this.finalizeFromPodLogs(exitCode);
        break;
      }
      await sleep(this.deps.pollIntervalMs);
    }
    if (!this.cachedResult) {
      this.finalize(KILLED_EXIT_CODE, "exit synthesized");
    }
    return this.cachedResult!;
  }

  private armTimeout(): void {
    if (!this.deps.timeoutMs) return;
    this.timeoutHandle = setTimeout(() => {
      if (this.cachedResult) return;
      this.timedOut = true;
      this.kill("SIGTERM").catch(() => undefined);
    }, this.deps.timeoutMs);
    this.timeoutHandle.unref?.();
  }

  private armPostKillWatchdog(): void {
    if (this.postKillTimer) return;
    this.postKillTimer = setTimeout(() => {
      if (this.cachedResult) return;
      this.finalize(KILLED_EXIT_CODE, "killed but never exited");
    }, this.deps.postKillWatchdogMs);
    this.postKillTimer.unref?.();
  }

  private async resolvePodNames(): Promise<string[]> {
    const pods = await this.deps.client.listPodsForJob(
      this.deps.namespace,
      this.deps.jobName
    );
    return pods
      .map((p) => p.metadata?.name)
      .filter((n): n is string => typeof n === "string");
  }

  private async resolveFailureExitCode(): Promise<number> {
    const pods = await this.deps.client
      .listPodsForJob(this.deps.namespace, this.deps.jobName)
      .catch(() => [] as Awaited<ReturnType<K8sClientLike["listPodsForJob"]>>);
    for (const pod of pods) {
      for (const cs of pod.status?.containerStatuses ?? []) {
        if (cs.state?.terminated?.exitCode !== undefined) {
          return cs.state.terminated.exitCode;
        }
      }
    }
    return JOB_FAILED_EXIT_CODE;
  }

  private async finalizeFromPodLogs(exitCode: number): Promise<void> {
    this.stopLogStream();
    try {
      const pods = await this.deps.client.listPodsForJob(
        this.deps.namespace,
        this.deps.jobName
      );
      for (const pod of pods) {
        const name = pod.metadata?.name;
        if (!name) continue;
        const log = await this.deps.client.readPodLog(this.deps.namespace, name);
        if (log && !this.stdoutBuf.includes(log)) {
          this.stdoutBuf += log;
        }
      }
    } catch {
      // best-effort; missing logs shouldn't block exit.
    }
    this.finalize(exitCode);
  }

  private async pokeLogStream(): Promise<void> {
    if (this.podName || !this.deps.useStreamingLogs) {
      if (!this.podName) {
        await this.tryStartPollingLogs();
      }
      return;
    }
    const pods = await this.deps.client.listPodsForJob(
      this.deps.namespace,
      this.deps.jobName
    );
    const pod = pods.find((p) => p.metadata?.name);
    if (!pod || !pod.metadata?.name) return;
    this.podName = pod.metadata.name;
    if (this.deps.client.streamPodLog) {
      const sink = new PassThrough();
      sink.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.stdoutBuf += text;
        this.bus.emit({
          kind: "stdout",
          at: new Date().toISOString(),
          data: text
        });
      });
      try {
        this.logAborter = await this.deps.client.streamPodLog(
          this.deps.namespace,
          this.podName,
          sink as Writable,
          { follow: true }
        );
      } catch {
        await this.tryStartPollingLogs();
      }
    } else {
      await this.tryStartPollingLogs();
    }
  }

  private async tryStartPollingLogs(): Promise<void> {
    if (this.logPollTimer) return;
    if (!this.podName) {
      const pods = await this.deps.client.listPodsForJob(
        this.deps.namespace,
        this.deps.jobName
      );
      const name = pods.find((p) => p.metadata?.name)?.metadata?.name;
      if (!name) return;
      this.podName = name;
    }
    const tick = async () => {
      if (this.cachedResult || !this.podName) return;
      try {
        const log = await this.deps.client.readPodLog(
          this.deps.namespace,
          this.podName,
          { sinceSeconds: this.logSinceSeconds || undefined }
        );
        if (log) {
          this.stdoutBuf += log;
          this.bus.emit({
            kind: "stdout",
            at: new Date().toISOString(),
            data: log
          });
        }
        this.logSinceSeconds = Math.max(
          this.logSinceSeconds,
          Math.ceil(this.deps.pollIntervalMs / 1_000) + 1
        );
      } catch {
        // ignore transient read failures
      }
    };
    this.logPollTimer = setInterval(tick, this.deps.pollIntervalMs);
    this.logPollTimer.unref?.();
    void tick();
  }

  private stopLogStream(): void {
    if (this.logAborter) {
      try {
        this.logAborter.abort();
      } catch {
        // ignore
      }
      this.logAborter = null;
    }
    if (this.logPollTimer) {
      clearInterval(this.logPollTimer);
      this.logPollTimer = null;
    }
  }

  private finalize(exitCode: number, reason?: string): void {
    if (this.cachedResult) return;
    const summary = buildSummary(this.stdoutBuf, this.stderrBuf, exitCode, reason);
    this.cachedResult = {
      exitCode,
      summary,
      stdout: this.stdoutBuf,
      stderr: this.stderrBuf
    };
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    if (this.postKillTimer) clearTimeout(this.postKillTimer);
    this.stopLogStream();
    this.bus.emit(
      { kind: "exit", at: new Date().toISOString(), data: String(exitCode) },
      true
    );
  }
}

/**
 * AgentExecutor that runs each ticket as a K8s Job against a PVC-backed
 * sandbox produced by PVCSandboxProvider. The worker image is expected to
 * consume the injected env (RELAY_WORK_REQUEST, RELAY_RUN_ID,
 * RELAY_TICKET_ID) and write its output under the mounted workdir.
 */
export class PodExecutor implements AgentExecutor {
  private readonly client: K8sClientLike;
  private readonly namespace: string;
  private readonly workerImage: string;
  private readonly imagePullSecrets: string[] | undefined;
  private readonly serviceAccountName: string | undefined;
  private readonly resources: PodExecutorOptions["resources"];
  private readonly pollIntervalMs: number;
  private readonly postKillWatchdogMs: number;
  private readonly useStreamingLogs: boolean;
  private counter = 0;

  constructor(options: PodExecutorOptions) {
    if (!options.namespace) throw new Error("PodExecutor requires a namespace");
    if (!options.workerImage) throw new Error("PodExecutor requires a workerImage");
    if (!options.k8sClient) throw new Error("PodExecutor requires a k8sClient");
    if (!options.sandboxProvider) {
      throw new Error("PodExecutor requires a sandboxProvider (PVCSandboxProvider)");
    }
    this.client = options.k8sClient;
    this.namespace = options.namespace;
    this.workerImage = options.workerImage;
    this.imagePullSecrets = options.imagePullSecrets;
    this.serviceAccountName = options.serviceAccountName;
    this.resources = options.resources;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.postKillWatchdogMs = options.postKillWatchdogMs ?? 30_000;
    this.useStreamingLogs = options.useStreamingLogs ?? true;
  }

  async start(
    ticket: TicketDefinition,
    opts: ExecutorStartOptions
  ): Promise<ExecutionHandle> {
    if (!opts.sandbox) {
      throw new Error("PodExecutor requires opts.sandbox (create via PVCSandboxProvider)");
    }
    const sandbox = opts.sandbox;
    if (sandbox.workdir.kind !== "remote") {
      throw new Error(
        `PodExecutor requires sandbox.workdir.kind === "remote"; got "${sandbox.workdir.kind}"`
      );
    }
    const parsed = parsePodUri(sandbox.workdir.uri);
    if (parsed.namespace !== this.namespace) {
      throw new Error(
        `Sandbox namespace ${parsed.namespace} does not match executor namespace ${this.namespace}`
      );
    }

    const workRequest = {
      runId: opts.runId,
      ticketId: ticket.id,
      specialty: ticket.specialty,
      title: ticket.title,
      objective: ticket.objective,
      acceptanceCriteria: ticket.acceptanceCriteria,
      allowedCommands: ticket.allowedCommands,
      verificationCommands: ticket.verificationCommands,
      docsToUpdate: ticket.docsToUpdate
    };

    const env: Array<{ name: string; value: string }> = [
      { name: "RELAY_RUN_ID", value: opts.runId },
      { name: "RELAY_TICKET_ID", value: ticket.id },
      { name: "RELAY_WORK_REQUEST", value: JSON.stringify(workRequest) }
    ];
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (value === undefined) continue;
      env.push({ name: key, value });
    }

    const jobName = `worker-${opts.runId}-${ticket.id}-${++this.counter}`.slice(0, 63);
    const labels = {
      "relay.run-id": opts.runId,
      "relay.ticket-id": ticket.id,
      "relay.role": "worker"
    };
    const job = buildJobManifest({
      jobName,
      namespace: this.namespace,
      pvcName: parsed.pvcName,
      mountPath: parsed.mountPath,
      workerImage: this.workerImage,
      imagePullSecrets: this.imagePullSecrets,
      serviceAccountName: this.serviceAccountName,
      env,
      resources: this.resources,
      labels,
      terminationGracePeriodSeconds: DEFAULT_TERMINATION_GRACE_S
    });

    await this.client.createJob(this.namespace, job);

    const handleId = `${ticket.id}-${Date.now()}-${this.counter}`;
    return new PodExecutionHandle({
      id: handleId,
      sandbox,
      namespace: this.namespace,
      jobName,
      client: this.client,
      pollIntervalMs: this.pollIntervalMs,
      postKillWatchdogMs: this.postKillWatchdogMs,
      timeoutMs: opts.timeoutMs,
      useStreamingLogs: this.useStreamingLogs
    });
  }
}

function buildSummary(
  stdout: string,
  stderr: string,
  exitCode: number,
  reason?: string
): string {
  if (reason) return reason;
  if (exitCode === 0 && stderr.trim() === "") {
    return stdout.slice(0, SUMMARY_PREFIX_LENGTH);
  }
  return `failed (exit ${exitCode})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
