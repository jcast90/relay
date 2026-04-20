/**
 * SCM integration facade.
 *
 * Wraps an AO `SCM` plugin with a narrower, harness-specific interface so the
 * rest of the codebase never imports AO types directly. Do not leak
 * `@aoagents/ao-core` types out of this module.
 */
import type {
  PRInfo,
  ProjectConfig,
  SCM,
  Session,
} from "@aoagents/ao-core";
import { create as createGithubScm } from "@aoagents/ao-plugin-scm-github";

import { withEnvOverride } from "./plugin-env-mutex.js";

/** Narrow PR shape the harness operates on. */
export interface HarnessPR {
  number: number;
  url: string;
  branch: string;
}

/** Minimal project descriptor needed to drive the SCM facade. */
export interface HarnessProject {
  owner: string;
  name: string;
  /** Local checkout path. Optional; defaults to cwd if the plugin needs it. */
  path?: string;
  /** Default branch name. Optional; defaults to "main". */
  defaultBranch?: string;
}

export type CiSummary = "pending" | "passing" | "failing" | "none";
export type ReviewDecision =
  | "approved"
  | "changes_requested"
  | "pending"
  | "none";

export interface PendingComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
}

export interface EnrichedPR {
  ci: CiSummary;
  review: ReviewDecision;
  prState: "open" | "merged" | "closed";
}

export interface HarnessScm {
  detectPR(
    branch: string,
    repo: { owner: string; name: string },
  ): Promise<HarnessPR | null>;
  getCiSummary(pr: HarnessPR): Promise<CiSummary>;
  getReviewDecision(pr: HarnessPR): Promise<ReviewDecision>;
  getPendingComments(pr: HarnessPR): Promise<PendingComment[]>;
  enrichBatch(prs: HarnessPR[]): Promise<Map<string, EnrichedPR>>;
}

/**
 * Build a configured AO `SCM` instance. The returned value is intentionally
 * typed as `SCM` so callers can pass it to `wrapScm`; callers outside this
 * module should not depend on any method beyond what `HarnessScm` exposes.
 *
 * Overloads:
 *  - No-token call: synchronous. The github plugin reads `GITHUB_TOKEN` via
 *    the `gh` CLI at command time, not at construction time, so no overlay
 *    is needed when the caller has already exported the env var.
 *  - With-token call: routes through the shared env-mutex so concurrent
 *    builds with different tokens can't observe each other's values.
 */
export function createScm(kind: "github"): SCM;
export function createScm(
  kind: "github",
  opts: { token?: undefined },
): SCM;
export function createScm(
  kind: "github",
  opts: { token: string },
): Promise<SCM>;
export function createScm(
  kind: "github",
  opts: { token?: string } = {},
): SCM | Promise<SCM> {
  if (kind !== "github") {
    throw new Error(`createScm: unsupported kind "${kind as string}"`);
  }
  if (opts.token === undefined) {
    return createGithubScm();
  }
  // The github plugin shells out to `gh`, which reads GITHUB_TOKEN from env.
  // Serialize overlays so two concurrent calls with different tokens can't
  // race through the env.
  return withEnvOverride({ GITHUB_TOKEN: opts.token }, () =>
    createGithubScm(),
  );
}

/** Produce the narrow facade from a raw AO `SCM`. */
export function wrapScm(scm: SCM, project: HarnessProject): HarnessScm {
  const projectConfig = toProjectConfig(project);

  const toPRInfo = (pr: HarnessPR): PRInfo => ({
    number: pr.number,
    url: pr.url,
    branch: pr.branch,
    title: "",
    owner: project.owner,
    repo: project.name,
    baseBranch: project.defaultBranch ?? "main",
    isDraft: false,
  });

  return {
    async detectPR(branch, repo) {
      const session = stubSession(branch);
      const cfg =
        repo.owner === project.owner && repo.name === project.name
          ? projectConfig
          : toProjectConfig({
              owner: repo.owner,
              name: repo.name,
              path: project.path,
              defaultBranch: project.defaultBranch,
            });
      const info = await scm.detectPR(session, cfg);
      if (!info) return null;
      return { number: info.number, url: info.url, branch: info.branch };
    },
    async getCiSummary(pr) {
      return scm.getCISummary(toPRInfo(pr));
    },
    async getReviewDecision(pr) {
      return scm.getReviewDecision(toPRInfo(pr));
    },
    async getPendingComments(pr) {
      const comments = await scm.getPendingComments(toPRInfo(pr));
      return comments.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        path: c.path,
        line: c.line,
      }));
    },
    async enrichBatch(prs) {
      const infos = prs.map(toPRInfo);
      const out = new Map<string, EnrichedPR>();
      if (typeof scm.enrichSessionsPRBatch === "function") {
        const raw = await scm.enrichSessionsPRBatch(infos);
        for (const [key, data] of raw) {
          out.set(key, {
            ci: data.ciStatus,
            review: data.reviewDecision,
            prState: data.state,
          });
        }
        return out;
      }
      // Fallback: sequential per-PR queries.
      for (const info of infos) {
        const [prState, ciStatus, reviewDecision] = await Promise.all([
          scm.getPRState(info),
          scm.getCISummary(info),
          scm.getReviewDecision(info),
        ]);
        out.set(`${info.owner}/${info.repo}#${info.number}`, {
          ci: ciStatus,
          review: reviewDecision,
          prState,
        });
      }
      return out;
    },
  };
}

function toProjectConfig(project: HarnessProject): ProjectConfig {
  return {
    name: `${project.owner}/${project.name}`,
    repo: `${project.owner}/${project.name}`,
    path: project.path ?? process.cwd(),
    defaultBranch: project.defaultBranch ?? "main",
    sessionPrefix: project.name,
  };
}

function stubSession(branch: string): Session {
  const now = new Date();
  return {
    id: `harness-scm-detect:${branch}`,
    projectId: "harness-scm-detect",
    status: "working",
    activity: null,
    branch,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: now,
    lastActivityAt: now,
    metadata: {},
  };
}
