import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRelayDir } from "./paths.js";

export interface WorkspaceRegistryEntry {
  workspaceId: string;
  repoPath: string;
  registeredAt: string;
  lastAccessedAt: string;
}

export interface WorkspaceRegistry {
  updatedAt: string;
  workspaces: WorkspaceRegistryEntry[];
}

const globalRoot = (): string => getRelayDir();
const registryPath = (): string => join(globalRoot(), "workspace-registry.json");

export function getGlobalRoot(): string {
  return globalRoot();
}

export function getRegistryPath(): string {
  return registryPath();
}

export function buildWorkspaceId(repoPath: string): string {
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  const basename = repoPath.split("/").filter(Boolean).pop() ?? "workspace";
  return `${basename}-${hash}`;
}

export function getWorkspaceDir(workspaceId: string): string {
  return join(globalRoot(), "workspaces", workspaceId);
}

export async function readRegistry(): Promise<WorkspaceRegistry> {
  try {
    const raw = JSON.parse(await readFile(registryPath(), "utf8")) as WorkspaceRegistry;
    return {
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : []
    };
  } catch {
    return { updatedAt: new Date().toISOString(), workspaces: [] };
  }
}

export async function writeRegistry(registry: WorkspaceRegistry): Promise<void> {
  await mkdir(globalRoot(), { recursive: true });
  const tmpPath = `${registryPath()}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(registry, null, 2));
  await rename(tmpPath, registryPath());
}

export async function registerWorkspace(repoPath: string): Promise<WorkspaceRegistryEntry> {
  const registry = await readRegistry();
  const workspaceId = buildWorkspaceId(repoPath);
  const now = new Date().toISOString();

  const existing = registry.workspaces.find((w) => w.workspaceId === workspaceId);

  if (existing) {
    existing.lastAccessedAt = now;
    existing.repoPath = repoPath;
    registry.updatedAt = now;
    await writeRegistry(registry);
    return existing;
  }

  const entry: WorkspaceRegistryEntry = {
    workspaceId,
    repoPath,
    registeredAt: now,
    lastAccessedAt: now
  };

  registry.workspaces.push(entry);
  registry.updatedAt = now;
  await writeRegistry(registry);

  return entry;
}

export async function resolveWorkspaceForRepo(repoPath: string): Promise<WorkspaceRegistryEntry | null> {
  const registry = await readRegistry();
  const workspaceId = buildWorkspaceId(repoPath);
  return registry.workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
}

export async function listRegisteredWorkspaces(): Promise<WorkspaceRegistryEntry[]> {
  const registry = await readRegistry();
  return registry.workspaces;
}
