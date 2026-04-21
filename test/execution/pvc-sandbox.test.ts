import { describe, expect, it, beforeEach } from "vitest";

import type {
  K8sClientLike,
  K8sJob,
  K8sPersistentVolumeClaim,
  K8sPod
} from "../../src/execution/k8s-client.js";
import { PVCSandboxProvider } from "../../src/execution/sandboxes/pvc-sandbox.js";

interface JobState {
  job: K8sJob;
  succeeded: boolean;
  failed: boolean;
  failureMessage?: string;
}

class FakeK8sClient implements K8sClientLike {
  readonly pvcs = new Map<string, K8sPersistentVolumeClaim>();
  readonly jobs = new Map<string, JobState>();
  public jobCreates: K8sJob[] = [];
  public pvcCreates: K8sPersistentVolumeClaim[] = [];
  public pvcDeletes: string[] = [];
  public jobDeletes: string[] = [];
  public autoSucceed = true;

  async createPersistentVolumeClaim(
    _ns: string,
    pvc: K8sPersistentVolumeClaim
  ): Promise<K8sPersistentVolumeClaim> {
    const name = pvc.metadata?.name ?? "";
    this.pvcs.set(name, pvc);
    this.pvcCreates.push(pvc);
    return pvc;
  }
  async readPersistentVolumeClaim(_ns: string, name: string) {
    return this.pvcs.get(name) ?? null;
  }
  async deletePersistentVolumeClaim(_ns: string, name: string) {
    this.pvcs.delete(name);
    this.pvcDeletes.push(name);
  }
  async createJob(_ns: string, job: K8sJob): Promise<K8sJob> {
    const name = job.metadata?.name ?? "";
    this.jobCreates.push(job);
    this.jobs.set(name, {
      job,
      succeeded: this.autoSucceed,
      failed: !this.autoSucceed
    });
    return job;
  }
  async readJob(_ns: string, name: string): Promise<K8sJob | null> {
    const state = this.jobs.get(name);
    if (!state) return null;
    return {
      ...state.job,
      status: {
        succeeded: state.succeeded ? 1 : 0,
        failed: state.failed ? 1 : 0,
        conditions: state.failed
          ? [{ type: "Failed", status: "True", message: state.failureMessage }]
          : undefined
      }
    };
  }
  async deleteJob(_ns: string, name: string) {
    this.jobs.delete(name);
    this.jobDeletes.push(name);
  }
  async listPodsForJob(_ns: string, _jobName: string): Promise<K8sPod[]> {
    return [];
  }
  async deletePod() {
    // noop
  }
  async readPodLog() {
    return "";
  }
}

describe("PVCSandboxProvider", () => {
  let client: FakeK8sClient;
  let provider: PVCSandboxProvider;

  beforeEach(() => {
    client = new FakeK8sClient();
    provider = new PVCSandboxProvider({
      namespace: "relay-test",
      k8sClient: client,
      storageClassName: "fast-ssd",
      storageSize: "2Gi",
      initPollIntervalMs: 1,
      initTimeoutMs: 1_000
    });
  });

  it("creates a PVC with the expected spec and an init job, then waits for success", async () => {
    const ref = await provider.create(
      { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
      "main",
      { runId: "r1", ticketId: "t1" }
    );

    expect(ref.id).toBe("pvc-r1-t1");
    expect(ref.workdir.kind).toBe("remote");
    expect(ref.workdir.kind === "remote" && ref.workdir.uri).toBe(
      "pod://relay-test/pvc-r1-t1:/work"
    );
    expect(ref.meta?.pvcName).toBe("pvc-r1-t1");
    expect(ref.meta?.namespace).toBe("relay-test");
    expect(ref.meta?.base).toBe("main");

    expect(client.pvcCreates).toHaveLength(1);
    const pvc = client.pvcCreates[0];
    expect(pvc.metadata?.name).toBe("pvc-r1-t1");
    expect(pvc.metadata?.labels?.["relay.run-id"]).toBe("r1");
    const pvcSpec = pvc.spec as { resources?: { requests?: { storage?: string } }; storageClassName?: string; accessModes?: string[] };
    expect(pvcSpec.resources?.requests?.storage).toBe("2Gi");
    expect(pvcSpec.storageClassName).toBe("fast-ssd");
    expect(pvcSpec.accessModes).toEqual(["ReadWriteOnce"]);

    expect(client.jobCreates).toHaveLength(1);
    const job = client.jobCreates[0];
    expect(job.metadata?.name).toBe("init-r1-t1");
    const template = (job.spec as { template: { spec: { containers: Array<{ args: string[]; volumeMounts: Array<{ name: string; mountPath: string }> }>; volumes: Array<{ persistentVolumeClaim?: { claimName: string } }> } } }).template;
    expect(template.spec.containers[0].args[0]).toContain("git clone");
    expect(template.spec.containers[0].args[0]).toContain("'https://example.com/repo.git'");
    expect(template.spec.containers[0].args[0]).toContain("git checkout 'main'");
    expect(template.spec.containers[0].volumeMounts[0]).toEqual({
      name: "work",
      mountPath: "/work"
    });
    expect(template.spec.volumes[0].persistentVolumeClaim?.claimName).toBe("pvc-r1-t1");

    // Init job is cleaned up after success.
    expect(client.jobDeletes).toContain("init-r1-t1");
  });

  it("reuses an existing PVC (idempotent create)", async () => {
    await provider.create(
      { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
      "main",
      { runId: "r2", ticketId: "t2" }
    );
    await provider.create(
      { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
      "main",
      { runId: "r2", ticketId: "t2" }
    );
    expect(client.pvcCreates).toHaveLength(1);
    expect(client.jobCreates).toHaveLength(2);
  });

  it("throws when init job fails and still cleans up the job", async () => {
    client.autoSucceed = false;
    await expect(
      provider.create(
        { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
        "main",
        { runId: "r3", ticketId: "t3" }
      )
    ).rejects.toThrow(/Init clone job/);
    expect(client.jobDeletes).toContain("init-r3-t3");
  });

  it("rejects unsafe runId/ticketId (K8s DNS-1123 and path traversal)", async () => {
    await expect(
      provider.create(
        { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
        "main",
        { runId: "bad/run", ticketId: "t" }
      )
    ).rejects.toThrow(/Unsafe/);
    await expect(
      provider.create(
        { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
        "main",
        { runId: "r", ticketId: ".." }
      )
    ).rejects.toThrow(/Unsafe/);
  });

  it("requires remoteUrl to seed the clone", async () => {
    await expect(
      provider.create({ root: "/tmp/fake" }, "main", {
        runId: "r4",
        ticketId: "t4"
      })
    ).rejects.toThrow(/remoteUrl/);
  });

  it("destroy deletes the PVC and is idempotent for missing refs", async () => {
    const ref = await provider.create(
      { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
      "main",
      { runId: "r5", ticketId: "t5" }
    );
    const res1 = await provider.destroy(ref);
    expect(res1.kind).toBe("removed");
    expect(client.pvcDeletes).toContain("pvc-r5-t5");
    const res2 = await provider.destroy(ref);
    expect(res2.kind).toBe("missing");
  });

  it("destroy with retain policy preserves the PVC", async () => {
    const retainClient = new FakeK8sClient();
    const retain = new PVCSandboxProvider({
      namespace: "relay-test",
      k8sClient: retainClient,
      destroyPolicy: "retain",
      initPollIntervalMs: 1
    });
    const ref = await retain.create(
      { root: "/tmp/fake", remoteUrl: "https://example.com/repo.git" },
      "main",
      { runId: "r6", ticketId: "t6" }
    );
    const res = await retain.destroy(ref);
    expect(res.kind).toBe("preserved");
    expect(retainClient.pvcDeletes).toHaveLength(0);
  });
});
