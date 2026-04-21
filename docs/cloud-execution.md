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

## Slug normalization

`runId` and `ticketId` are user-controlled, but Kubernetes resource names
must be valid DNS-1123 labels (lowercase alphanumeric + `-`, start/end
alphanumeric, ≤ 63 chars). The helpers in `src/execution/k8s-names.ts`
apply a deterministic pipeline:

1. `assertSafePathSegment` rejects whitespace, `/`, `\`, null bytes, and
   `..` traversal fragments up front.
2. `slugifyForK8s` lowercases, collapses any non-`[a-z0-9-]` run into a
   single `-`, and trims leading/trailing hyphens.
3. `finalizeK8sName` caps the composed name at 63 chars and strips
   trailing non-alphanumerics so a mid-hyphen truncation can't produce an
   invalid name.
4. `sanitizeK8sLabelValue` is used for `relay.run-id` / `relay.ticket-id`
   label values. Labels preserve case and allow `.`/`_`, but still must
   start+end with an alphanumeric and stay ≤ 63 chars.

## PVC reuse guard (label match)

`ensurePvc` reads the existing PVC by name. If it exists, we check the
`relay.run-id` / `relay.ticket-id` labels against the caller's sanitized
values. Two inputs that slugify to the same PVC name but have different
original identifiers will produce different labels — the second `create()`
throws an error containing both label sets rather than silently reusing
the foreign run's volume.

The match is exact string equality on the sanitized label value, not on
the raw input, so a restart of the same run with the same id is still
idempotent.

## `readJob` retry policy

`wait()` wraps each `readJob` tick in a try/catch. One transient 5xx,
network blip, or DNS glitch is absorbed — the loop logs a warning with the
failure count and backs off for `pollIntervalMs` before retrying. After
`maxConsecutivePollFailures` consecutive failures (default: 5) the handle
finalizes with exit code 1, a summary of `"K8s API unavailable after N
retries: <last error>"`, and an identical stderr event so users see why
their run stopped. A successful read resets the counter.

## Log stream mid-disconnect

The streaming log sink has explicit `error` and `close` handlers. If the
stream ends before the worker exits (pod eviction, log-api restart,
network partition), the executor emits a `stderr` event of the form
`[pod-executor] log stream ended unexpectedly: <reason>` so the failure
is visible in the run's event log. The `wait()` poll loop is unaffected
— it continues reading Job status and will finalize normally when the
pod terminates.

## Running integration tests

The integration test file
`test/execution/pod-executor.integration.test.ts` is skipped unless
`RELAY_TEST_K8S_KUBECONFIG` is set. With a local cluster available:

```sh
kind create cluster --name relay-t403
export RELAY_TEST_K8S_KUBECONFIG=$(kind get kubeconfig-path --name relay-t403 2>/dev/null || echo ~/.kube/config)
export RELAY_TEST_K8S_NAMESPACE=default
export RELAY_TEST_WORKER_IMAGE=busybox:1.36
pnpm test
kind delete cluster --name relay-t403
```

Or with k3d:

```sh
k3d cluster create relay-t403
export RELAY_TEST_K8S_KUBECONFIG=~/.kube/config
pnpm test
k3d cluster delete relay-t403
```

Unit tests use the in-memory `K8sClientLike` fake and always run — the
integration test is gated behind the env var so CI without a cluster
isn't required to provision one.
