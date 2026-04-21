# Cloud Execution (Kubernetes)

Relay can run each ticket as a Kubernetes Job against a PVC-backed sandbox.
Two building blocks ship with this feature:

- `PVCSandboxProvider` — creates a namespace-scoped `PersistentVolumeClaim`
  and seeds it with the repo contents via a short init `Job` that runs
  `git clone`.
- `PodExecutor` — implements `AgentExecutor` by launching a worker `Job`
  that mounts the PVC at the sandbox workdir and runs the provided
  `workerImage`.

The executor polls the Job's status (default 3s cadence) and streams pod
logs. When the Job reports `succeeded`, logs are drained and `wait()`
resolves with the terminated container's `exitCode`. On `kill()`, the
executor deletes the Pod then the Job with background propagation.

## Worker image contract

The worker image is supplied by the operator. On startup the executor
injects three environment variables:

- `RELAY_RUN_ID` — orchestrator run id
- `RELAY_TICKET_ID` — ticket id
- `RELAY_WORK_REQUEST` — JSON-serialized work request (title, objective,
  acceptance criteria, allowed/verification commands, docs to update)

The container's `workingDir` is set to the mounted PVC path (default
`/work`), and the repo is already checked out at the requested base ref.
The container should write its output under `$PWD` — results are persisted
in the PVC until the sandbox is destroyed.

## Local testing with kind

```sh
kind create cluster --name relay-t403
export RELAY_TEST_K8S_KUBECONFIG=$(kind get kubeconfig --name relay-t403)
export RELAY_TEST_K8S_NAMESPACE=default
export RELAY_TEST_WORKER_IMAGE=busybox:1.36
pnpm test
kind delete cluster --name relay-t403
```

Unit tests use an in-memory `K8sClientLike` fake and run everywhere; the
file `test/execution/pod-executor.integration.test.ts` is skipped unless
`RELAY_TEST_K8S_KUBECONFIG` is set.

## Composition

Wiring `HARNESS_EXECUTOR=pod` into the orchestrator constructor is deferred
to a follow-up PR. Until then, consumers instantiate the executor directly:

```ts
const k8s = await createDefaultK8sClient({ kubeconfig });
const sandboxes = new PVCSandboxProvider({ namespace, k8sClient: k8s });
const executor = new PodExecutor({
  sandboxProvider: sandboxes,
  k8sClient: k8s,
  namespace,
  workerImage: "ghcr.io/example/relay-worker:latest"
});
```

## Security posture

- Every Job and PVC is namespace-scoped. Tenant isolation is an operator
  concern: run each tenant in its own namespace and bind a restricted
  ServiceAccount via `serviceAccountName`.
- The worker pod has read/write access to the PVC. Do NOT share a PVC
  across tenants — `PVCSandboxProvider` uses `pvc-<runId>-<ticketId>` names
  so each sandbox lives in its own volume.
- `destroyPolicy: "retain"` can be set to keep PVCs for out-of-band GC
  (audit, forensics). The default `"delete"` removes the PVC on teardown.
- RBAC manifests and Helm charts are out of scope for this PR; an ops
  ticket will follow.
