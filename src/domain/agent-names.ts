import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type { AgentProvider, AgentRole } from "./agent.js";

export interface AgentNameEntry {
  agentId: string;
  displayName: string;
  provider: AgentProvider;
  role: AgentRole;
  updatedAt: string;
}

const NAMES_PATH = join(homedir(), ".agent-harness", "agent-names.json");

export async function setAgentName(
  agentId: string,
  displayName: string,
  provider: AgentProvider,
  role: AgentRole
): Promise<AgentNameEntry> {
  const entries = await listAgentNames();
  const now = new Date().toISOString();
  const entry: AgentNameEntry = { agentId, displayName, provider, role, updatedAt: now };
  const index = entries.findIndex((e) => e.agentId === agentId);

  if (index >= 0) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }

  const tmpPath = `${NAMES_PATH}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2));
  await rename(tmpPath, NAMES_PATH);

  return entry;
}

export async function getAgentName(agentId: string): Promise<string> {
  const entries = await listAgentNames();
  return entries.find((e) => e.agentId === agentId)?.displayName ?? agentId;
}

export async function listAgentNames(): Promise<AgentNameEntry[]> {
  try {
    return JSON.parse(await readFile(NAMES_PATH, "utf8")) as AgentNameEntry[];
  } catch {
    return [];
  }
}
