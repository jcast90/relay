import type {
  DestroyResult,
  RepoRef,
  SandboxProvider,
  SandboxRef
} from "../sandbox.js";
import type {
  K8sClientLike,
  K8sJob,
  K8sPersistentVolumeClaim
} from "../k8s-client.js";

const DEFAULT_STORAGE_SIZE = "1Gi";
const DEFAULT_INIT_IMAGE = "alpine/git:latest";
const DEFAULT_INIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_WORKDIR = "/work";

export interface PVCSandboxProviderOptions {
  namespace: string;
  k8sClient: K8sClientLike;
  /**
   * Optional storage class for the PVC. Omit to let the cluster pick its
   * default provisioner.
   */
  storageClassName?: string;
  /** Requested volume size. Defaults to 1Gi. */
  storageSize?: string;
  /** Image used to clone the repo into the PVC. */
  initContainerImage?: string;
  /**
   * Namespace-local workdir mount path inside the init container (and later
   * the worker pod). Defaults to /work.
   */
  workdir?: string;
  /**
   * Max time to wait for the init clone job to succeed. Exceeding this throws
   * and the PVC is left in place for diagnostic inspection.
   */
  initTimeoutMs?: number;
  /**
   * Poll cadence while waiting for the init job. Separate from
   * `initTimeoutMs` so tests can tighten the loop.
   */
  initPollIntervalMs?: number;
  /**
   * Destroy policy. `"delete"` removes the PVC on destroy(); `"retain"` marks
   * it as preserved for GC out-of-band (e.g. an ops sweep). Default: delete.
   */
  destroyPolicy?: "delete" | "retain";
}

export interface PVCSandboxCreateOptions {
  runId: string;
  ticketId: string;
}

export interface PVCSandboxMeta extends Record<string, string> {
  pvcName: string;
  namespace: string;
  base: string;
  runId: string;
  ticketId: string;
  workdir: string;
}

const TRAVERSAL_RE = /[\s/\\\0]|\.\.|^\.$/;

function assertSafePathSegment(value: string, kind: string): void {
  // Reject traversal / whitespace / null bytes before we attempt to use the id
  // in any resource name. DNS-1123 legality is handled separately by slugify.
  if (!value || TRAVERSAL_RE.test(value)) {
    throw new Error(`Unsafe ${kind} segment: ${JSON.stringify(value)}`);
  }
}

function slugifyForK8s(value: string): string {
  // K8s object names are DNS-1123 labels: lowercase alphanumeric + hyphen,
  // starting and ending with alphanumeric. We lowercase, replace runs of
  // non-matching chars with '-', and trim leading/trailing non-alphanum.
  const lowered = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lowered.replace(/^[-]+|[-]+$/g, "");
  return trimmed || "x";
}

/**
 * SandboxProvider that backs each ticket with a namespace-scoped
 * PersistentVolumeClaim seeded by an init Job that clones the repo at the
 * requested base. The resulting SandboxRef is remote — only the PodExecutor
 * (or another K8s-aware executor) can consume it.
 */
export class PVCSandboxProvider implements SandboxProvider {
  private readonly namespace: string;
  private readonly client: K8sClientLike;
  private readonly storageClassName: string | undefined;
  private readonly storageSize: string;
  private readonly initContainerImage: string;
  private readonly workdir: string;
  private readonly initTimeoutMs: number;
  private readonly initPollIntervalMs: number;
  private readonly destroyPolicy: "delete" | "retain";

  constructor(options: PVCSandboxProviderOptions) {
    if (!options.namespace) {
      throw new Error("PVCSandboxProvider requires a namespace");
    }
    if (!options.k8sClient) {
      throw new Error("PVCSandboxProvider requires a k8sClient");
    }
    this.namespace = options.namespace;
    this.client = options.k8sClient;
    this.storageClassName = options.storageClassName;
    this.storageSize = options.storageSize ?? DEFAULT_STORAGE_SIZE;
    this.initContainerImage = options.initContainerImage ?? DEFAULT_INIT_IMAGE;
    this.workdir = options.workdir ?? DEFAULT_WORKDIR;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.initPollIntervalMs = options.initPollIntervalMs ?? 2_000;
    this.destroyPolicy = options.destroyPolicy ?? "delete";
  }

  async create(
    repo: RepoRef,
    base: string,
    options?: PVCSandboxCreateOptions
  ): Promise<SandboxRef> {
    if (!options) {
      throw new Error("PVCSandboxProvider.create requires { runId, ticketId }");
    }
    const runId = requireNonEmpty(options.runId, "runId");
    const ticketId = requireNonEmpty(options.ticketId, "ticketId");
    assertSafePathSegment(runId, "runId");
    assertSafePathSegment(ticketId, "ticketId");

    if (!repo.remoteUrl) {
      throw new Error(
        "PVCSandboxProvider.create requires repo.remoteUrl to seed the PVC clone"
      );
    }

    const runSlug = slugifyForK8s(runId);
    const ticketSlug = slugifyForK8s(ticketId);
    const pvcName = `pvc-${runSlug}-${ticketSlug}`.slice(0, 63);
    const jobName = `init-${runSlug}-${ticketSlug}`.slice(0, 63);

    await this.ensurePvc(pvcName, runId, ticketId);

    const job = this.buildInitJob(jobName, pvcName, repo.remoteUrl, base, runId, ticketId);
    await this.client.createJob(this.namespace, job);
    try {
      await this.waitForJob(jobName);
    } finally {
      // Init jobs are short-lived; we always tear them down even on failure
      // so the namespace stays tidy. The PVC survives for the executor.
      await this.client
        .deleteJob(this.namespace, jobName, { propagationPolicy: "Background" })
        .catch(() => undefined);
    }

    const meta: PVCSandboxMeta = {
      pvcName,
      namespace: this.namespace,
      base,
      runId,
      ticketId,
      workdir: this.workdir
    };

    return {
      id: pvcName,
      workdir: {
        kind: "remote",
        uri: `pod://${this.namespace}/${pvcName}:${this.workdir}`
      },
      meta
    };
  }

  async destroy(ref: SandboxRef): Promise<DestroyResult> {
    if (ref.workdir.kind !== "remote") return { kind: "missing" };
    const pvcName = ref.meta?.pvcName ?? ref.id;
    const namespace = ref.meta?.namespace ?? this.namespace;
    if (this.destroyPolicy === "retain") {
      return { kind: "preserved", reason: "dirty", stderr: "retain policy" };
    }
    const existing = await this.client.readPersistentVolumeClaim(namespace, pvcName);
    if (!existing) return { kind: "missing" };
    await this.client.deletePersistentVolumeClaim(namespace, pvcName, {
      propagationPolicy: "Background"
    });
    return { kind: "removed" };
  }

  private async ensurePvc(
    pvcName: string,
    runId: string,
    ticketId: string
  ): Promise<void> {
    const existing = await this.client.readPersistentVolumeClaim(
      this.namespace,
      pvcName
    );
    if (existing) return;
    const pvc: K8sPersistentVolumeClaim = {
      metadata: {
        name: pvcName,
        namespace: this.namespace,
        labels: {
          "relay.run-id": runId,
          "relay.ticket-id": ticketId,
          "relay.role": "sandbox"
        }
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: this.storageSize } },
        ...(this.storageClassName ? { storageClassName: this.storageClassName } : {})
      }
    };
    await this.client.createPersistentVolumeClaim(this.namespace, pvc);
  }

  private buildInitJob(
    jobName: string,
    pvcName: string,
    remoteUrl: string,
    base: string,
    runId: string,
    ticketId: string
  ): K8sJob {
    return {
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          "relay.run-id": runId,
          "relay.ticket-id": ticketId,
          "relay.role": "sandbox-init"
        }
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 60,
        template: {
          metadata: {
            labels: {
              "relay.run-id": runId,
              "relay.ticket-id": ticketId,
              "relay.role": "sandbox-init"
            }
          },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "clone",
                image: this.initContainerImage,
                command: ["/bin/sh", "-c"],
                args: [
                  // Clone the repo into the empty PVC and check out `base`.
                  // Use a sub-shell trap so the exit code flows out.
                  `set -euo pipefail; ` +
                    `cd ${this.workdir}; ` +
                    `git clone --no-single-branch ${shellEscape(remoteUrl)} . && ` +
                    `git checkout ${shellEscape(base)}`
                ],
                volumeMounts: [{ name: "work", mountPath: this.workdir }]
              }
            ],
            volumes: [
              {
                name: "work",
                persistentVolumeClaim: { claimName: pvcName }
              }
            ]
          }
        }
      }
    };
  }

  private async waitForJob(jobName: string): Promise<void> {
    const deadline = Date.now() + this.initTimeoutMs;
    while (Date.now() < deadline) {
      const job = await this.client.readJob(this.namespace, jobName);
      const status = job?.status;
      if (status?.succeeded && status.succeeded > 0) return;
      if (status?.failed && status.failed > 0) {
        const reason = status.conditions?.find((c) => c.type === "Failed")?.message;
        throw new Error(
          `Init clone job ${jobName} failed${reason ? `: ${reason}` : ""}`
        );
      }
      await sleep(this.initPollIntervalMs);
    }
    throw new Error(
      `Init clone job ${jobName} did not complete within ${this.initTimeoutMs}ms`
    );
  }
}

function requireNonEmpty(value: string | undefined, kind: string): string {
  if (!value) throw new Error(`PVCSandboxProvider.create: ${kind} required`);
  return value;
}

function shellEscape(value: string): string {
  // Single-quote wrap and escape embedded quotes. The init job runs via
  // /bin/sh -c, so this is the safest way to pass opaque ref/url text
  // without further substitution.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
