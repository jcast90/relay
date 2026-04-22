import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunIndexEntry } from "../domain/run.js";
import type { LocalArtifactStore } from "../execution/artifact-store.js";
import { buildWorkspaceId, getWorkspaceDir, registerWorkspace } from "./workspace-registry.js";

export interface HarnessWorkspacePaths {
  rootDir: string;
  artifactsDir: string;
  serviceStatusPath: string;
  runsIndexPath: string;
}

export interface HarnessServiceStatus {
  state: "ready";
  workspaceRoot: string;
  workspaceId: string;
  artifactsDir: string;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export async function ensureHarnessWorkspace(
  cwd: string,
  version: string
): Promise<{
  paths: HarnessWorkspacePaths;
  status: HarnessServiceStatus;
}> {
  await registerWorkspace(cwd);
  const paths = getHarnessWorkspacePaths(cwd);

  await mkdir(paths.artifactsDir, {
    recursive: true,
  });

  const existing = await readHarnessServiceStatus(paths.serviceStatusPath);
  const now = new Date().toISOString();
  const status: HarnessServiceStatus = {
    state: "ready",
    workspaceRoot: cwd,
    workspaceId: buildWorkspaceId(cwd),
    artifactsDir: paths.artifactsDir,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version,
  };

  await writeFile(paths.serviceStatusPath, JSON.stringify(status, null, 2));

  return {
    paths,
    status,
  };
}

export function getHarnessWorkspacePaths(cwd: string): HarnessWorkspacePaths {
  const workspaceId = buildWorkspaceId(cwd);
  const rootDir = getWorkspaceDir(workspaceId);

  return {
    rootDir,
    artifactsDir: join(rootDir, "artifacts"),
    serviceStatusPath: join(rootDir, "service-status.json"),
    runsIndexPath: join(rootDir, "artifacts", "runs-index.json"),
  };
}

export async function readHarnessServiceStatus(path: string): Promise<HarnessServiceStatus | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HarnessServiceStatus;
  } catch {
    return null;
  }
}

export async function readWorkspaceSummary(
  artifactStore: LocalArtifactStore,
  cwd: string
): Promise<{
  paths: HarnessWorkspacePaths;
  status: HarnessServiceStatus | null;
  recentRuns: RunIndexEntry[];
}> {
  const paths = getHarnessWorkspacePaths(cwd);
  const [status, recentRuns] = await Promise.all([
    readHarnessServiceStatus(paths.serviceStatusPath),
    artifactStore.readRunsIndex(),
  ]);

  return {
    paths,
    status,
    recentRuns,
  };
}
