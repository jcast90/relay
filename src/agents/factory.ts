import type { Agent, AgentProvider, AgentRole } from "../domain/agent.js";
import type { AgentSpecialty } from "../domain/specialty.js";
import { setAgentName } from "../domain/agent-names.js";

import { ClaudeCliAgent, CodexCliAgent } from "./cli-agents.js";
import { NodeCommandInvoker, type CommandInvoker } from "./command-invoker.js";

export interface AgentSpec {
  id: string;
  displayName: string;
  role: AgentRole;
  specialties: AgentSpecialty[];
}

const AGENT_SPECS: AgentSpec[] = [
  {
    id: "atlas",
    displayName: "Atlas (Planner)",
    role: "planner",
    specialties: ["general"]
  },
  {
    id: "pixel",
    displayName: "Pixel (UI Engineer)",
    role: "implementer",
    specialties: ["ui", "general"]
  },
  {
    id: "forge",
    displayName: "Forge (Backend Engineer)",
    role: "implementer",
    specialties: ["api_crud", "business_logic", "general"]
  },
  {
    id: "lens",
    displayName: "Lens (Code Reviewer)",
    role: "reviewer",
    specialties: ["general", "ui", "business_logic", "api_crud"]
  },
  {
    id: "probe",
    displayName: "Probe (Test Engineer)",
    role: "tester",
    specialties: ["general", "ui", "business_logic", "api_crud"]
  }
];

interface AgentFactoryOptions {
  cwd: string;
  invoker?: CommandInvoker;
  provider?: AgentProvider;
  model?: string;
}

export function createLiveAgents(options: AgentFactoryOptions): Agent[] {
  const invoker = options.invoker ?? new NodeCommandInvoker();
  const provider = options.provider ?? "claude";
  const AgentClass = provider === "codex" ? CodexCliAgent : ClaudeCliAgent;

  return AGENT_SPECS.map((spec) =>
    new AgentClass({
      id: spec.id,
      name: spec.displayName,
      provider,
      capability: {
        role: spec.role,
        specialties: spec.specialties
      },
      cwd: options.cwd,
      model: options.model,
      invoker
    })
  );
}

export async function registerAgentNames(provider: AgentProvider = "claude"): Promise<void> {
  for (const spec of AGENT_SPECS) {
    await setAgentName(spec.id, spec.displayName, provider, spec.role);
  }
}

export { AGENT_SPECS };
