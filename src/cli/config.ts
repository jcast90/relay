import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface HarnessGlobalConfig {
  /** Directories to scan for git repos (e.g. ["~/projects", "~/turingon/Dev"]) */
  projectDirs: string[];
}

const GLOBAL_ROOT = join(homedir(), ".agent-harness");
const CONFIG_PATH = join(GLOBAL_ROOT, "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export async function readConfig(): Promise<HarnessGlobalConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<HarnessGlobalConfig>;
    return {
      projectDirs: Array.isArray(raw.projectDirs)
        ? raw.projectDirs.map(expandHome)
        : []
    };
  } catch {
    return { projectDirs: [] };
  }
}

export async function writeConfig(config: HarnessGlobalConfig): Promise<void> {
  await mkdir(GLOBAL_ROOT, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2));
  await rename(tmpPath, CONFIG_PATH);
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
