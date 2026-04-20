/**
 * Discriminated union describing where a sandbox's working directory lives.
 *
 * - `local` — a real, on-disk absolute path. Executors that spawn child
 *   processes against the filesystem can operate directly on this.
 * - `remote` — an opaque URI for cloud/remote impls (e.g. "pod://ns/name:/work",
 *   "vercel-sandbox://…"). Consumers that need a local path should use
 *   {@link resolveLocalPath} and guard on `null`.
 */
export type Workdir =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "remote"; readonly uri: string };

export interface SandboxRef {
  /** Stable id so handlers can look up the same sandbox across restarts. */
  readonly id: string;
  /** Discriminated workdir — see {@link Workdir}. */
  readonly workdir: Workdir;
  /** Free-form metadata the provider chose to stamp (branch, commit, etc.). */
  readonly meta?: Record<string, string>;
}

export interface RepoRef {
  /** Absolute path to the origin repo. Cloud impls may use this as a clone source. */
  root: string;
  /** Remote URL (optional) — useful when the sandbox is created from a bare clone. */
  remoteUrl?: string;
}

export interface SandboxProvider {
  /** Create a sandbox rooted at `base` (typically a branch or commit ref). */
  create(repo: RepoRef, base: string): Promise<SandboxRef>;
  /** Destroy the sandbox. Idempotent — calling on a missing sandbox is a no-op. */
  destroy(ref: SandboxRef): Promise<void>;
}

/**
 * Return a local filesystem path for the sandbox if one exists, else null.
 *
 * Free-function rather than an interface method so every `SandboxProvider`
 * gets correct behavior for free — the answer is entirely determined by the
 * ref's discriminant. Callers that need a local path (e.g. the
 * LocalChildProcessExecutor) should guard on `null`; remote-only providers
 * naturally return `null` without any per-impl code.
 */
export function resolveLocalPath(ref: SandboxRef): string | null {
  return ref.workdir.kind === "local" ? ref.workdir.path : null;
}
