export interface SandboxRef {
  /** Stable id so handlers can look up the same sandbox across restarts. */
  id: string;
  /** Where the workdir lives. For local impls, an absolute path. For remote
   *  impls, an opaque URI like "pod://ns/name:/work" or "vercel-sandbox://…". */
  workdir: string;
  /** Free-form metadata the provider chose to stamp (branch, commit, etc.). */
  meta?: Record<string, string>;
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
  /** Return a local path for the sandbox if one exists, else null. Callers
   *  that need a local path (e.g. the LocalChildProcessExecutor) will guard
   *  on null; remote-only providers can return null without breaking. */
  resolvePath(ref: SandboxRef): string | null;
}
