import type { Writable } from "node:stream";
import { describe, expect, it, beforeEach } from "vitest";

import type { TicketDefinition } from "../../src/domain/ticket.js";
import type { ExecutionEvent } from "../../src/execution/executor.js";
import type {
  K8sClientLike,
  K8sJob,
  K8sPersistentVolumeClaim,
  K8sPod
} from "../../src/execution/k8s-client.js";
import { PodExecutor } from "../../src/execution/pod-executor.js";
import { PVCSandboxProvider } from "../../src/execution/sandboxes/pvc-sandbox.js";
import type { SandboxRef } from "../../src/execution/sandbox.js";

function makeTicket(partial: Partial<TicketDefinition> = {}): TicketDefinition {
  return {
    id: partial.id ?? "T-pod",
    title: partial.title ?? "Pod test",
    objective: partial.objective ?? "Run in a pod",
    specialty: partial.specialty ?? "general",
    acceptanceCriteria: partial.acceptanceCriteria ?? ["pod exits 0"],
    allowedCommands: partial.allowedCommands ?? [],
    verificationCommands: partial.verificationCommands ?? [],
    docsToUpdate: partial.docsToUpdate ?? [],
    dependsOn: partial.dependsOn ?? [],
    retryPolicy: partial.retryPolicy ?? { maxAgentAttempts: 1, maxTestFixLoops: 1 }
  };
}

interface JobRecord {
  job: K8sJob;
  succeeded: number;
  failed: number;
  terminatedExitCode?: number;
}

class FakeK8sClient implements K8sClientLike {
  readonly pvcs = new Map<string, K8sPersistentVolumeClaim>();
  readonly jobs = new Map<string, JobRecord>();
  readonly podsForJob = new Map<string, K8sPod[]>();
  public jobCreates: K8sJob[] = [];
  public jobDeletes: string[] = [];
  public podDeletes: string[] = [];
  public logReads: Array<{ name: string; since?: number }> = [];
  public logStreamCalls = 0;
  public logsByPod = new Map<string, string>();
  public enableStreaming = false;

  async createPersistentVolumeClaim(_ns: string, pvc: K8sPersistentVolumeClaim) {
    this.pvcs.set(pvc.metadata?.name ?? "", pvc);
    return pvc;
  }
  async readPersistentVolumeClaim(_ns: string, name: string) {
    return this.pvcs.get(name) ?? null;
  }
  async deletePersistentVolumeClaim(_ns: string, name: string) {
    this.pvcs.delete(name);
  }
  async createJob(_ns: string, job: K8sJob): Promise<K8sJob> {
    const name = job.metadata?.name ?? "";
    this.jobCreates.push(job);
    this.jobs.set(name, { job, succeeded: 0, failed: 0 });
    return job;
  }
  async readJob(_ns: string, name: string): Promise<K8sJob | null> {
    const rec = this.jobs.get(name);
    if (!rec) return null;
    return {
      ...rec.job,
      status: {
        succeeded: rec.succeeded,
        failed: rec.failed
      }
    };
  }
  async deleteJob(_ns: string, name: string) {
    this.jobDeletes.push(name);
    this.jobs.delete(name);
  }
  async listPodsForJob(_ns: string, jobName: string): Promise<K8sPod[]> {
    return this.podsForJob.get(jobName) ?? [];
  }
  async deletePod(_ns: string, name: string) {
    this.podDeletes.push(name);
  }
  async readPodLog(
    _ns: string,
    podName: string,
    opts?: { sinceSeconds?: number }
  ): Promise<string> {
    this.logReads.push({ name: podName, since: opts?.sinceSeconds });
    return this.logsByPod.get(podName) ?? "";
  }
  // Optional — only present when streaming is enabled
  streamPodLog?(
    _ns: string,
    podName: string,
    stream: Writable
  ): Promise<AbortController> {
    if (!this.enableStreaming) throw new Error("streaming disabled");
    this.logStreamCalls += 1;
    const controller = new AbortController();
    const chunk = this.logsByPod.get(podName) ?? "";
    if (chunk) setImmediate(() => stream.write(chunk));
    return Promise.resolve(controller);
  }
}

function makeStreamCapableClient(): FakeK8sClient {
  const c = new FakeK8sClient();
  c.enableStreaming = true;
  return c;
}

function makeNonStreamingClient(): FakeK8sClient {
  const c = new FakeK8sClient();
  // Remove the streamPodLog method to simulate a client that doesn't implement it.
  delete (c as Partial<K8sClientLike>).streamPodLog;
  return c;
}

async function createSandbox(
  client: FakeK8sClient,
  runId: string,
  ticketId: string
): Promise<SandboxRef> {
  const provider = new PVCSandboxProvider({
    namespace: "relay-test",
    k8sClient: client,
    initPollIntervalMs: 1,
    initTimeoutMs: 1_000
  });
  // Pre-mark job success so PVC init returns immediately.
  const originalCreateJob = client.createJob.bind(client);
  client.createJob = async (ns, job) => {
    const res = await originalCreateJob(ns, job);
    const name = job.metadata?.name ?? "";
    const rec = client.jobs.get(name);
    if (rec) rec.succeeded = 1;
    return res;
  };
  const ref = await provider.create(
    { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
    "main",
    { runId, ticketId }
  );
  // Reset for executor flow. Clear init-job bookkeeping so tests that
  // inspect `client.jobCreates[0]` see only the worker Job the executor
  // is about to produce.
  client.createJob = originalCreateJob;
  client.jobCreates = [];
  client.jobDeletes = [];
  return ref;
}

async function collect(
  stream: AsyncIterable<ExecutionEvent>,
  limit = 10
): Promise<ExecutionEvent[]> {
  const out: ExecutionEvent[] = [];
  for await (const ev of stream) {
    out.push(ev);
    if (out.length >= limit) break;
  }
  return out;
}

describe("PodExecutor", () => {
  let client: FakeK8sClient;
  let provider: PVCSandboxProvider;
  let executor: PodExecutor;
  let sandbox: SandboxRef;

  beforeEach(async () => {
    client = makeStreamCapableClient();
    sandbox = await createSandbox(client, "r", "T1");
    provider = new PVCSandboxProvider({
      namespace: "relay-test",
      k8sClient: client
    });
    executor = new PodExecutor({
      sandboxProvider: provider,
      k8sClient: client,
      namespace: "relay-test",
      workerImage: "ghcr.io/example/worker:latest",
      pollIntervalMs: 5,
      postKillWatchdogMs: 50
    });
  });

  it("creates a Job referencing the PVC and mounting at the parsed workdir", async () => {
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    expect(client.jobCreates).toHaveLength(1);
    const job = client.jobCreates[0];
    const template = job.spec as {
      template: {
        spec: {
          containers: Array<{
            image: string;
            workingDir: string;
            env: Array<{ name: string; value: string }>;
            volumeMounts: Array<{ name: string; mountPath: string }>;
          }>;
          volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>;
        };
      };
    };
    expect(template.template.spec.containers[0].image).toBe(
      "ghcr.io/example/worker:latest"
    );
    expect(template.template.spec.containers[0].workingDir).toBe("/work");
    expect(template.template.spec.containers[0].volumeMounts[0].mountPath).toBe(
      "/work"
    );
    expect(template.template.spec.volumes[0].persistentVolumeClaim?.claimName).toBe(
      "pvc-r-t1"
    );
    const envByName = Object.fromEntries(
      template.template.spec.containers[0].env.map((e) => [e.name, e.value])
    );
    expect(envByName.RELAY_RUN_ID).toBe("r");
    expect(envByName.RELAY_TICKET_ID).toBe("T1");
    expect(JSON.parse(envByName.RELAY_WORK_REQUEST)).toMatchObject({
      runId: "r",
      ticketId: "T1",
      title: "Pod test"
    });
    // kill the handle to release its internal timers
    await handle.kill();
  });

  it("wait() resolves with exitCode 0 once the Job reports success", async () => {
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [
      {
        metadata: { name: `${jobName}-pod` },
        status: {
          containerStatuses: [
            { name: "worker", state: { terminated: { exitCode: 0 } } }
          ]
        }
      }
    ]);
    client.logsByPod.set(`${jobName}-pod`, "hello from pod\n");
    // Flip succeeded shortly after start
    setTimeout(() => {
      const rec = client.jobs.get(jobName)!;
      rec.succeeded = 1;
    }, 10);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from pod");
    expect(handle.status).toBe("exited");
  });

  it("wait() resolves with the terminated container exitCode on Job failure", async () => {
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [
      {
        metadata: { name: `${jobName}-pod` },
        status: {
          containerStatuses: [
            { name: "worker", state: { terminated: { exitCode: 42 } } }
          ]
        }
      }
    ]);
    setTimeout(() => {
      const rec = client.jobs.get(jobName)!;
      rec.failed = 1;
    }, 10);
    const result = await handle.wait();
    expect(result.exitCode).toBe(42);
  });

  it("kill() deletes the Pod and the Job, and wait resolves as killed", async () => {
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [
      { metadata: { name: `${jobName}-pod` } }
    ]);
    await handle.kill();
    const result = await handle.wait();
    expect(client.jobDeletes).toContain(jobName);
    expect(client.podDeletes).toContain(`${jobName}-pod`);
    expect(result.exitCode).toBe(137);
    expect(handle.status).toBe("killed");
  });

  it("stream() yields stdout chunks from the streaming client", async () => {
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [
      {
        metadata: { name: `${jobName}-pod` },
        status: {
          containerStatuses: [
            { name: "worker", state: { terminated: { exitCode: 0 } } }
          ]
        }
      }
    ]);
    client.logsByPod.set(`${jobName}-pod`, "chunk-A\nchunk-B\n");
    setTimeout(() => {
      const rec = client.jobs.get(jobName)!;
      rec.succeeded = 1;
    }, 15);
    // Fire wait() so the executor's poll loop drives state transitions; the
    // stream subscribes to events it emits.
    const waitPromise = handle.wait();
    const events = await collect(handle.stream(), 20);
    await waitPromise;
    const stdoutEvents = events.filter((e) => e.kind === "stdout");
    // Deterministic assertion: the streaming hook writes the configured
    // chunk synchronously (via setImmediate), so at least one stdout event
    // MUST be observed and MUST include the seeded chunk.
    expect(stdoutEvents.length).toBeGreaterThan(0);
    const concatenated = stdoutEvents.map((e) => String(e.data)).join("");
    expect(concatenated).toContain("chunk-A");
    expect(events.some((e) => e.kind === "start")).toBe(true);
    expect(events.some((e) => e.kind === "exit")).toBe(true);
  });

  it("falls back to polling logs when streamPodLog isn't implemented", async () => {
    const noStreamClient = makeNonStreamingClient();
    const sb = await createSandbox(noStreamClient, "r2", "T2");
    const exec2 = new PodExecutor({
      sandboxProvider: new PVCSandboxProvider({
        namespace: "relay-test",
        k8sClient: noStreamClient
      }),
      k8sClient: noStreamClient,
      namespace: "relay-test",
      workerImage: "ghcr.io/example/worker:latest",
      pollIntervalMs: 5,
      postKillWatchdogMs: 50
    });
    const handle = await exec2.start(makeTicket({ id: "T2" }), {
      runId: "r2",
      repoRoot: "/tmp/fake",
      sandbox: sb
    });
    const jobName = noStreamClient.jobCreates[0].metadata?.name!;
    noStreamClient.podsForJob.set(jobName, [
      {
        metadata: { name: `${jobName}-pod` },
        status: {
          containerStatuses: [
            { name: "worker", state: { terminated: { exitCode: 0 } } }
          ]
        }
      }
    ]);
    noStreamClient.logsByPod.set(`${jobName}-pod`, "polled-line\n");
    setTimeout(() => {
      const rec = noStreamClient.jobs.get(jobName)!;
      rec.succeeded = 1;
    }, 10);
    const result = await handle.wait();
    expect(noStreamClient.logReads.length).toBeGreaterThanOrEqual(1);
    expect(result.stdout).toContain("polled-line");
  });

  it("kill() after wait() resolves is a no-op (idempotent)", async () => {
    // Parity with LocalChildProcessExecutor contract: kill() after exit is
    // a no-op and must not tear down an already-cleaned resource a second
    // time. We prove it by counting deleteJob calls.
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [
      {
        metadata: { name: `${jobName}-pod` },
        status: {
          containerStatuses: [
            { name: "worker", state: { terminated: { exitCode: 0 } } }
          ]
        }
      }
    ]);
    setTimeout(() => {
      const rec = client.jobs.get(jobName)!;
      rec.succeeded = 1;
    }, 5);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    const jobDeletesBefore = client.jobDeletes.length;
    const podDeletesBefore = client.podDeletes.length;
    await handle.kill();
    expect(client.jobDeletes).toHaveLength(jobDeletesBefore);
    expect(client.podDeletes).toHaveLength(podDeletesBefore);
    expect(handle.status).toBe("exited");
  });

  it("double kill() is a no-op on the second call", async () => {
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [{ metadata: { name: `${jobName}-pod` } }]);
    await handle.kill();
    const jobDeletesAfterFirst = client.jobDeletes.length;
    const podDeletesAfterFirst = client.podDeletes.length;
    await handle.kill();
    // Second kill must NOT re-issue API calls.
    expect(client.jobDeletes).toHaveLength(jobDeletesAfterFirst);
    expect(client.podDeletes).toHaveLength(podDeletesAfterFirst);
    await handle.wait();
    expect(handle.status).toBe("killed");
  });

  it("post-kill watchdog synthesizes exit 137 when the Job never flips", async () => {
    // Fake never marks the job as failed/succeeded after deleteJob. The
    // watchdog must fire within postKillWatchdogMs and finalize the handle
    // with exit 137 and reason "killed but never exited".
    const stuckClient = makeStreamCapableClient();
    // Override deleteJob so the Job record stays put and readJob keeps
    // returning running status. This simulates a wedged kubelet/api where
    // the Job stays "active" indefinitely.
    stuckClient.deleteJob = async (_ns: string, name: string) => {
      stuckClient.jobDeletes.push(name);
      // Deliberately DO NOT delete from `stuckClient.jobs` so readJob still returns running.
    };
    const sb = await createSandbox(stuckClient, "rr", "TW");
    const exec2 = new PodExecutor({
      sandboxProvider: new PVCSandboxProvider({
        namespace: "relay-test",
        k8sClient: stuckClient
      }),
      k8sClient: stuckClient,
      namespace: "relay-test",
      workerImage: "ghcr.io/example/worker:latest",
      pollIntervalMs: 5,
      postKillWatchdogMs: 30
    });
    const handle = await exec2.start(makeTicket({ id: "TW" }), {
      runId: "rr",
      repoRoot: "/tmp/fake",
      sandbox: sb
    });
    const jobName = stuckClient.jobCreates[0].metadata?.name!;
    stuckClient.podsForJob.set(jobName, [{ metadata: { name: `${jobName}-pod` } }]);
    await handle.kill();
    const result = await handle.wait();
    expect(result.exitCode).toBe(137);
    expect(result.summary).toContain("killed but never exited");
  });

  it("initTimeoutMs exceeded causes sandbox create() to reject", async () => {
    // The init job never reports succeeded/failed; the provider must give
    // up after initTimeoutMs and surface a timeout error.
    const slowClient = new FakeK8sClient();
    // Do not flip succeeded. Default FakeK8sClient leaves both at 0.
    const slow = new PVCSandboxProvider({
      namespace: "relay-test",
      k8sClient: slowClient,
      initPollIntervalMs: 2,
      initTimeoutMs: 15
    });
    await expect(
      slow.create(
        { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
        "main",
        { runId: "slow", ticketId: "T" }
      )
    ).rejects.toThrow(/did not complete within/);
  });

  it("slug collision: two creates with ids that slugify the same throw label-mismatch", async () => {
    // "MY_RUN" lowercases to "my_run", then `_` collapses to `-` → "my-run".
    // "my-run" slugifies to itself. Both produce pvc-my-run-t1, but the
    // labels (preserved via sanitizeK8sLabelValue, which keeps `_`) differ.
    // The second create() must refuse rather than silently reuse a foreign
    // run's volume.
    const collideClient = new FakeK8sClient();
    const provider = new PVCSandboxProvider({
      namespace: "relay-test",
      k8sClient: collideClient,
      initPollIntervalMs: 1,
      initTimeoutMs: 1_000
    });
    // Auto-succeed init jobs so create() doesn't hang on the first call.
    const originalCreate = collideClient.createJob.bind(collideClient);
    collideClient.createJob = async (ns, job) => {
      const res = await originalCreate(ns, job);
      const name = job.metadata?.name ?? "";
      const rec = collideClient.jobs.get(name);
      if (rec) rec.succeeded = 1;
      return res;
    };
    await provider.create(
      { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
      "main",
      { runId: "MY_RUN", ticketId: "T1" }
    );
    await expect(
      provider.create(
        { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
        "main",
        { runId: "my-run", ticketId: "T1" }
      )
    ).rejects.toThrow(/already exists with labels/);
  });

  it("readJob transient failures are retried up to maxConsecutivePollFailures", async () => {
    // Three transient failures then success: wait() must still resolve.
    const handle = await executor.start(makeTicket({ id: "T1" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox
    });
    const jobName = client.jobCreates[0].metadata?.name!;
    client.podsForJob.set(jobName, [
      {
        metadata: { name: `${jobName}-pod` },
        status: {
          containerStatuses: [
            { name: "worker", state: { terminated: { exitCode: 0 } } }
          ]
        }
      }
    ]);
    let calls = 0;
    const realReadJob = client.readJob.bind(client);
    client.readJob = async (ns, name) => {
      calls += 1;
      if (calls <= 3) throw new Error(`simulated transient 5xx #${calls}`);
      return realReadJob(ns, name);
    };
    setTimeout(() => {
      const rec = client.jobs.get(jobName)!;
      rec.succeeded = 1;
    }, 20);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(calls).toBeGreaterThan(3);
  });

  it("readJob persistent failures finalize with an API-unavailable error", async () => {
    const sb2 = await createSandbox(client, "r", "TX");
    const exec2 = new PodExecutor({
      sandboxProvider: new PVCSandboxProvider({
        namespace: "relay-test",
        k8sClient: client
      }),
      k8sClient: client,
      namespace: "relay-test",
      workerImage: "ghcr.io/example/worker:latest",
      pollIntervalMs: 2,
      postKillWatchdogMs: 50,
      maxConsecutivePollFailures: 3
    });
    const handle = await exec2.start(makeTicket({ id: "TX" }), {
      runId: "r",
      repoRoot: "/tmp/fake",
      sandbox: sb2
    });
    // Force readJob to fail forever.
    client.readJob = async () => {
      throw new Error("simulated persistent API down");
    };
    const result = await handle.wait();
    expect(result.summary).toMatch(/K8s API unavailable after 3 retries/);
    expect(result.stderr).toMatch(/K8s API unavailable after 3 retries/);
  });

  it("surfaces an actionable error when the k8s client module fails to load", async () => {
    // `wrapK8sLoader` is the exported helper that wraps the dynamic import
    // in `createDefaultK8sClient`. Feeding it a rejecting loader simulates
    // the real `ERR_MODULE_NOT_FOUND` shape an operator sees when they run
    // `HARNESS_EXECUTOR=pod` without installing `@kubernetes/client-node`.
    const { wrapK8sLoader } = await import("../../src/execution/k8s-client.js");
    const brokenLoader = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find package '@kubernetes/client-node'"), {
          code: "ERR_MODULE_NOT_FOUND"
        })
      );
    await expect(wrapK8sLoader(brokenLoader)).rejects.toThrow(
      /@kubernetes\/client-node is required for HARNESS_EXECUTOR=pod/
    );
    await expect(wrapK8sLoader(brokenLoader)).rejects.toThrow(
      /pnpm add @kubernetes\/client-node/
    );
  });

  it("requires a remote sandbox in the matching namespace", async () => {
    const otherSandbox: SandboxRef = {
      id: "x",
      workdir: { kind: "remote", uri: "pod://other-ns/x:/work" },
      meta: { pvcName: "x", namespace: "other-ns" }
    };
    await expect(
      executor.start(makeTicket({ id: "T1" }), {
        runId: "r",
        repoRoot: "/tmp/fake",
        sandbox: otherSandbox
      })
    ).rejects.toThrow(/namespace/);

    const localSandbox: SandboxRef = {
      id: "y",
      workdir: { kind: "local", path: "/tmp/fake" }
    };
    await expect(
      executor.start(makeTicket({ id: "T1" }), {
        runId: "r",
        repoRoot: "/tmp/fake",
        sandbox: localSandbox
      })
    ).rejects.toThrow(/remote/);
  });
});
