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
import {
  finalizeK8sName,
  sanitizeK8sLabelValue,
  slugifyForK8s
} from "./k8s-names.js";
import type { PVCSandboxProvider } from "./sandboxes/pvc-sandbox.js";

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_TERMINATION_GRACE_S = 10;
const KILLED_EXIT_CODE = 137;
const JOB_FAILED_EXIT_CODE = 1;
const SUMMARY_PREFIX_LENGTH = 120;
const DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES = 5;

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  /**
   * Number of consecutive `readJob` failures tolerated inside `wait()`
   * before we give up and surface an "API unavailable" error. Defaults to
   * 5. A single transient 5xx or network blip must not terminate the run.
   */
  maxConsecutivePollFailures?: number;
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
  maxConsecutivePollFailures: number;
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
    // Idempotent: if wait() has already resolved OR a prior kill() started
    // the teardown, this call is a no-op. The post-kill watchdog ensures
    // wait() can't hang even if the underlying API is unresponsive.
    if (this.cachedResult) return;
    if (this.killRequested) return;
    this.killRequested = true;
    this.armPostKillWatchdog();
    this.stopLogStream();
    const podNames = await this.resolvePodNames().catch((err) => {
      console.warn(
        `[pod-executor] kill: resolvePodNames failed for ${this.deps.jobName}: ${formatErr(err)}`
      );
      return [] as string[];
    });
    for (const name of podNames) {
      await this.deps.client
        .deletePod(this.deps.namespace, name, { gracePeriodSeconds: 5 })
        .catch((err) => {
          console.warn(
            `[pod-executor] kill: deletePod ${name} failed: ${formatErr(err)}`
          );
        });
    }
    await this.deps.client
      .deleteJob(this.deps.namespace, this.deps.jobName, {
        propagationPolicy: "Background"
      })
      .catch((err) => {
        console.warn(
          `[pod-executor] kill: deleteJob ${this.deps.jobName} failed: ${formatErr(err)}`
        );
      });
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
    this.pokeLogStream().catch((err) => {
      console.warn(
        `[pod-executor] wait: initial pokeLogStream failed for ${this.deps.jobName}: ${formatErr(err)}`
      );
    });

    let consecutiveFailures = 0;
    let lastPollError: unknown = null;

    while (!this.cachedResult) {
      if (Date.now() >= deadline && !this.timedOut) {
        this.timedOut = true;
        await this.kill("SIGTERM");
      }
      // Wrap the poll tick: a single transient 5xx / network blip must not
      // terminate wait(). We count consecutive failures and give up cleanly
      // only after `maxConsecutivePollFailures` in a row — at which point
      // we surface the real reason instead of hanging.
      let job: K8sJob | null;
      try {
        job = await this.deps.client.readJob(this.deps.namespace, this.deps.jobName);
        consecutiveFailures = 0;
        lastPollError = null;
      } catch (err) {
        consecutiveFailures += 1;
        lastPollError = err;
        console.warn(
          `[pod-executor] wait: readJob ${this.deps.jobName} failed ` +
            `(${consecutiveFailures}/${this.deps.maxConsecutivePollFailures}), ` +
            `backing off ${this.deps.pollIntervalMs}ms: ${formatErr(err)}`
        );
        if (consecutiveFailures >= this.deps.maxConsecutivePollFailures) {
          this.bus.emit({
            kind: "stderr",
            at: new Date().toISOString(),
            data: `[pod-executor] K8s API unavailable after ${this.deps.maxConsecutivePollFailures} retries: ${formatErr(lastPollError)}\n`
          });
          this.stderrBuf += `[pod-executor] K8s API unavailable after ${this.deps.maxConsecutivePollFailures} retries: ${formatErr(lastPollError)}\n`;
          this.finalize(
            JOB_FAILED_EXIT_CODE,
            `K8s API unavailable after ${this.deps.maxConsecutivePollFailures} retries: ${formatErr(lastPollError)}`
          );
          break;
        }
        await sleep(this.deps.pollIntervalMs);
        continue;
      }
      if (!job) {
        this.finalize(this.killRequested ? KILLED_EXIT_CODE : JOB_FAILED_EXIT_CODE, "job missing");
        break;
      }
      const status = job.status ?? {};
      if (this.podName === null) {
        await this.pokeLogStream().catch((err) => {
          console.warn(
            `[pod-executor] wait: pokeLogStream failed for ${this.deps.jobName}: ${formatErr(err)}`
          );
        });
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
      this.kill("SIGTERM").catch((err) => {
        console.warn(
          `[pod-executor] timeout: kill(${this.deps.jobName}) failed: ${formatErr(err)}`
        );
      });
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
      .catch((err) => {
        console.warn(
          `[pod-executor] resolveFailureExitCode: listPodsForJob ${this.deps.jobName} failed: ${formatErr(err)}`
        );
        return [] as Awaited<ReturnType<K8sClientLike["listPodsForJob"]>>;
      });
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
        try {
          const log = await this.deps.client.readPodLog(this.deps.namespace, name);
          if (log && !this.stdoutBuf.includes(log)) {
            this.stdoutBuf += log;
          }
        } catch (logErr) {
          // Surface the failure to the user via stderr so they don't wonder
          // why stdout is empty. The exit code is already determined; we
          // just couldn't retrieve the pod's output.
          const msg = `[pod-executor] logs unavailable for pod ${name}: ${formatErr(logErr)}\n`;
          console.warn(msg.trim());
          this.stderrBuf += msg;
        }
      }
    } catch (err) {
      const msg = `[pod-executor] logs unavailable (listPodsForJob failed): ${formatErr(err)}\n`;
      console.warn(msg.trim());
      this.stderrBuf += msg;
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
      const emitStreamEnd = (reason: string): void => {
        if (this.cachedResult) return;
        // The user sees this on any mid-run disconnect (network blip, pod
        // eviction, log-api crash). wait() will continue polling readJob and
        // will finalize when the Job itself reports succeeded/failed.
        const msg = `[pod-executor] log stream ended unexpectedly: ${reason}\n`;
        this.stderrBuf += msg;
        this.bus.emit({
          kind: "stderr",
          at: new Date().toISOString(),
          data: msg
        });
      };
      sink.on("error", (err) => emitStreamEnd(formatErr(err)));
      sink.on("close", () => emitStreamEnd("sink closed"));
      try {
        this.logAborter = await this.deps.client.streamPodLog(
          this.deps.namespace,
          this.podName,
          sink as Writable,
          { follow: true }
        );
      } catch (err) {
        console.warn(
          `[pod-executor] streamPodLog ${this.podName} failed, falling back to poll: ${formatErr(err)}`
        );
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
      } catch (err) {
        // Transient read failures don't kill wait() — it has its own
        // readJob-based poll loop. We warn so repeated failures are visible.
        console.warn(
          `[pod-executor] log poll tick failed for ${this.podName}: ${formatErr(err)}`
        );
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
      } catch (err) {
        console.warn(
          `[pod-executor] stopLogStream: aborter.abort() threw: ${formatErr(err)}`
        );
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
  private readonly maxConsecutivePollFailures: number;
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
    this.maxConsecutivePollFailures =
      options.maxConsecutivePollFailures ?? DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES;
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

    // Slugify + finalize so arbitrary runId/ticketId (UUIDs, uppercase, `_`)
    // produce DNS-1123 legal names. `finalizeK8sName` caps at 63 chars and
    // strips trailing `-` so the name ends in an alphanumeric as required.
    const runSlug = slugifyForK8s(opts.runId);
    const ticketSlug = slugifyForK8s(ticket.id);
    const counter = ++this.counter;
    const jobName = finalizeK8sName(`worker-${runSlug}-${ticketSlug}-${counter}`);
    // Label values allow `.` and `_` in addition to DNS-1123's alphabet, but
    // must start+end alphanumeric and stay <= 63 chars. We sanitize here so
    // later label selectors (e.g. the PVC reuse guard) round-trip cleanly.
    const labels = {
      "relay.run-id": sanitizeK8sLabelValue(opts.runId),
      "relay.ticket-id": sanitizeK8sLabelValue(ticket.id),
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

    const handleId = `${ticket.id}-${Date.now()}-${counter}`;
    return new PodExecutionHandle({
      id: handleId,
      sandbox,
      namespace: this.namespace,
      jobName,
      client: this.client,
      pollIntervalMs: this.pollIntervalMs,
      postKillWatchdogMs: this.postKillWatchdogMs,
      timeoutMs: opts.timeoutMs,
      useStreamingLogs: this.useStreamingLogs,
      maxConsecutivePollFailures: this.maxConsecutivePollFailures
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
