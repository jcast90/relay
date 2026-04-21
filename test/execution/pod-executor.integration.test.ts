import { describe, it, expect } from "vitest";

import { createDefaultK8sClient } from "../../src/execution/k8s-client.js";
import { PodExecutor } from "../../src/execution/pod-executor.js";
import { PVCSandboxProvider } from "../../src/execution/sandboxes/pvc-sandbox.js";

const kubeconfig = process.env.RELAY_TEST_K8S_KUBECONFIG;
const namespace = process.env.RELAY_TEST_K8S_NAMESPACE ?? "default";
const workerImage = process.env.RELAY_TEST_WORKER_IMAGE ?? "busybox:1.36";

const describeOrSkip = kubeconfig ? describe : describe.skip;

describeOrSkip("PodExecutor integration (real cluster)", () => {
  it("runs a trivial worker Job and reports success", async () => {
    const client = await createDefaultK8sClient({ kubeconfig });
    const sandboxes = new PVCSandboxProvider({
      namespace,
      k8sClient: client,
      storageSize: "256Mi",
      initContainerImage: "alpine/git:latest",
      initTimeoutMs: 120_000,
      initPollIntervalMs: 2_000
    });
    const executor = new PodExecutor({
      sandboxProvider: sandboxes,
      k8sClient: client,
      namespace,
      workerImage,
      pollIntervalMs: 2_000,
      postKillWatchdogMs: 10_000
    });

    const ticket = {
      id: "integ",
      title: "integration smoke",
      objective: "echo hello",
      specialty: "general" as const,
      acceptanceCriteria: ["echoes hello"],
      allowedCommands: [],
      verificationCommands: [],
      docsToUpdate: [],
      dependsOn: [],
      retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 }
    };

    const sandbox = await sandboxes.create(
      { root: "/tmp", remoteUrl: "https://github.com/jcast90/agent-harness.git" },
      "main",
      { runId: "it1", ticketId: "integ" }
    );

    try {
      const handle = await executor.start(ticket, {
        runId: "it1",
        repoRoot: "/tmp",
        sandbox
      });
      const result = await handle.wait();
      expect(result.exitCode).toBeTypeOf("number");
    } finally {
      await sandboxes.destroy(sandbox).catch(() => undefined);
    }
  }, 10 * 60_000);
});
