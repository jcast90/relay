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
  provider?: AgentProvider;
  model?: string;
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
  defaultProvider?: AgentProvider;
  defaultModel?: string;
  overrides?: Record<string, { provider?: AgentProvider; model?: string }>;
}

export function createLiveAgents(options: AgentFactoryOptions): Agent[] {
  const invoker = options.invoker ?? new NodeCommandInvoker();
  const defaultProvider = options.defaultProvider ?? "claude";

  return AGENT_SPECS.map((spec) => {
    const override = options.overrides?.[spec.id];
    const provider = override?.provider ?? spec.provider ?? defaultProvider;
    const model = override?.model ?? spec.model ?? options.defaultModel;
    const AgentClass = provider === "codex" ? CodexCliAgent : ClaudeCliAgent;

    return new AgentClass({
      id: spec.id,
      name: spec.displayName,
      provider,
      capability: {
        role: spec.role,
        specialties: spec.specialties
      },
      cwd: options.cwd,
      model,
      invoker
    });
  });
}

export async function registerAgentNames(options?: {
  defaultProvider?: AgentProvider;
  overrides?: Record<string, { provider?: AgentProvider }>;
}): Promise<void> {
  const defaultProvider = options?.defaultProvider ?? "claude";

  for (const spec of AGENT_SPECS) {
    const provider = options?.overrides?.[spec.id]?.provider ?? spec.provider ?? defaultProvider;
    await setAgentName(spec.id, spec.displayName, provider, spec.role);
  }
}

export { AGENT_SPECS };
