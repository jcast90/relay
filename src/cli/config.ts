import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  DEFAULT_TRACKER_CONFIG,
  parseTrackerConfig,
  type TrackerConfig,
} from "../domain/tracker-config.js";
import { getRelayDir } from "./paths.js";

export interface HarnessGlobalConfig {
  /** Directories to scan for git repos (e.g. ["~/projects", "~/work"]) */
  projectDirs: string[];
  /**
   * Tracker integration config. Optional in the on-disk shape — a
   * config file predating v0.2 has no `tracker` block, and `readConfig`
   * synthesizes the default (`relay_native` only) so callers can rely
   * on this field always being present.
   */
  tracker: TrackerConfig;
}

const globalRoot = (): string => getRelayDir();
const configPath = (): string => join(globalRoot(), "config.json");

export function getConfigPath(): string {
  return configPath();
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export async function readConfig(): Promise<HarnessGlobalConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
    return {
      projectDirs: Array.isArray(raw.projectDirs)
        ? (raw.projectDirs as string[]).map(expandHome)
        : [],
      tracker: parseTrackerConfig(raw.tracker),
    };
  } catch {
    return { projectDirs: [], tracker: DEFAULT_TRACKER_CONFIG };
  }
}

export async function writeConfig(config: HarnessGlobalConfig): Promise<void> {
  await mkdir(globalRoot(), { recursive: true });
  const tmpPath = `${configPath()}.tmp.${process.pid}`;
  // Preserve any unknown top-level keys we read off disk so a future
  // config field added by a newer Relay doesn't get silently dropped
  // when an older version round-trips the file.
  const merged: Record<string, unknown> = {
    projectDirs: config.projectDirs,
    tracker: config.tracker,
  };
  await writeFile(tmpPath, JSON.stringify(merged, null, 2));
  await rename(tmpPath, configPath());
}

export async function addProjectDir(dir: string): Promise<HarnessGlobalConfig> {
  const config = await readConfig();
  const resolved = expandHome(dir);

  if (!config.projectDirs.includes(resolved)) {
    config.projectDirs.push(resolved);
    await writeConfig(config);
  }

  return config;
}

export async function removeProjectDir(dir: string): Promise<HarnessGlobalConfig> {
  const config = await readConfig();
  const resolved = expandHome(dir);
  config.projectDirs = config.projectDirs.filter((d) => d !== resolved);
  await writeConfig(config);
  return config;
}
