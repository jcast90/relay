import type { Writable } from "node:stream";

/**
 * Minimal surface of @kubernetes/client-node that the pod executor and PVC
 * sandbox rely on. Kept narrow so tests can inject fakes without reproducing
 * the full generated client.
 */

export interface K8sJobStatus {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

export interface K8sJob {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
  status?: K8sJobStatus;
}

export interface K8sPodContainerState {
  terminated?: { exitCode?: number; reason?: string; message?: string };
  running?: Record<string, unknown>;
  waiting?: { reason?: string; message?: string };
}

export interface K8sPodContainerStatus {
  name: string;
  state?: K8sPodContainerState;
  ready?: boolean;
  restartCount?: number;
}

export interface K8sPodStatus {
  phase?: string;
  containerStatuses?: K8sPodContainerStatus[];
}

export interface K8sPod {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  status?: K8sPodStatus;
}

export interface K8sPersistentVolumeClaim {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface K8sDeleteOptions {
  gracePeriodSeconds?: number;
  propagationPolicy?: "Orphan" | "Background" | "Foreground";
}

export interface K8sClientLike {
  createPersistentVolumeClaim(
    namespace: string,
    pvc: K8sPersistentVolumeClaim
  ): Promise<K8sPersistentVolumeClaim>;
  readPersistentVolumeClaim(
    namespace: string,
    name: string
  ): Promise<K8sPersistentVolumeClaim | null>;
  deletePersistentVolumeClaim(
    namespace: string,
    name: string,
    opts?: K8sDeleteOptions
  ): Promise<void>;

  createJob(namespace: string, job: K8sJob): Promise<K8sJob>;
  readJob(namespace: string, name: string): Promise<K8sJob | null>;
  deleteJob(namespace: string, name: string, opts?: K8sDeleteOptions): Promise<void>;

  listPodsForJob(namespace: string, jobName: string): Promise<K8sPod[]>;
  deletePod(namespace: string, name: string, opts?: K8sDeleteOptions): Promise<void>;
  readPodLog(
    namespace: string,
    podName: string,
    opts?: { container?: string; tailLines?: number; sinceSeconds?: number }
  ): Promise<string>;
  /**
   * Stream logs for a pod container to the provided writable. Returns an
   * abort controller — calling `abort()` cancels the log stream. Optional:
   * fakes may omit this and callers will fall back to polling `readPodLog`.
   */
  streamPodLog?(
    namespace: string,
    podName: string,
    stream: Writable,
    opts?: { container?: string; follow?: boolean }
  ): Promise<AbortController>;
}

export interface DefaultK8sClientOptions {
  kubeconfig?: string;
}

/**
 * Lazy-imported so unit tests that inject a fake never touch the real
 * package's transitive deps.
 */
export async function createDefaultK8sClient(
  options: DefaultK8sClientOptions = {}
): Promise<K8sClientLike> {
  const k8s = await import("@kubernetes/client-node");
  const config = new k8s.KubeConfig();
  if (options.kubeconfig) {
    config.loadFromFile(options.kubeconfig);
  } else {
    config.loadFromDefault();
  }
  const core = config.makeApiClient(k8s.CoreV1Api);
  const batch = config.makeApiClient(k8s.BatchV1Api);
  const logApi = new k8s.Log(config);

  return {
    async createPersistentVolumeClaim(namespace, pvc) {
      const res = await core.createNamespacedPersistentVolumeClaim({
        namespace,
        body: pvc as never
      });
      return res as unknown as K8sPersistentVolumeClaim;
    },
    async readPersistentVolumeClaim(namespace, name) {
      try {
        const res = await core.readNamespacedPersistentVolumeClaim({ name, namespace });
        return res as unknown as K8sPersistentVolumeClaim;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async deletePersistentVolumeClaim(namespace, name, opts) {
      try {
        await core.deleteNamespacedPersistentVolumeClaim({
          name,
          namespace,
          gracePeriodSeconds: opts?.gracePeriodSeconds,
          propagationPolicy: opts?.propagationPolicy
        });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },

    async createJob(namespace, job) {
      const res = await batch.createNamespacedJob({ namespace, body: job as never });
      return res as unknown as K8sJob;
    },
    async readJob(namespace, name) {
      try {
        const res = await batch.readNamespacedJob({ name, namespace });
        return res as unknown as K8sJob;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async deleteJob(namespace, name, opts) {
      try {
        await batch.deleteNamespacedJob({
          name,
          namespace,
          gracePeriodSeconds: opts?.gracePeriodSeconds,
          propagationPolicy: opts?.propagationPolicy ?? "Background"
        });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },

    async listPodsForJob(namespace, jobName) {
      const res = await core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`
      });
      const items = (res as unknown as { items?: K8sPod[] }).items ?? [];
      return items;
    },
    async deletePod(namespace, name, opts) {
      try {
        await core.deleteNamespacedPod({
          name,
          namespace,
          gracePeriodSeconds: opts?.gracePeriodSeconds,
          propagationPolicy: opts?.propagationPolicy
        });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },
    async readPodLog(namespace, podName, opts) {
      const res = await core.readNamespacedPodLog({
        name: podName,
        namespace,
        container: opts?.container,
        sinceSeconds: opts?.sinceSeconds,
        tailLines: opts?.tailLines
      });
      if (typeof res === "string") return res;
      return String(res ?? "");
    },
    async streamPodLog(namespace, podName, stream, opts) {
      return logApi.log(namespace, podName, opts?.container ?? "", stream, {
        follow: opts?.follow ?? true
      });
    }
  };
}

function isNotFound(err: unknown): boolean {
  const anyErr = err as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number };
  };
  return (
    anyErr?.code === 404 ||
    anyErr?.statusCode === 404 ||
    anyErr?.response?.statusCode === 404
  );
}
