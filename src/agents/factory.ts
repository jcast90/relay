import type { Agent } from "../domain/agent.js";
import { setAgentName } from "../domain/agent-names.js";

import { ClaudeCliAgent, CodexCliAgent } from "./cli-agents.js";
import { NodeCommandInvoker, type CommandInvoker } from "./command-invoker.js";

interface AgentFactoryOptions {
  cwd: string;
  invoker?: CommandInvoker;
  codexModel?: string;
  claudeModel?: string;
}

interface AgentSpec {
  id: string;
  displayName: string;
  provider: "claude" | "codex";
  role: "planner" | "implementer" | "reviewer" | "tester";
  specialties: Array<"general" | "ui" | "business_logic" | "api_crud" | "devops" | "testing">;
  model?: string;
}

const AGENT_SPECS: AgentSpec[] = [
  {
    id: "planner-claude",
    displayName: "Atlas (Planner)",
    provider: "claude",
    role: "planner",
    specialties: ["general"]
  },
  {
    id: "implementer-ui-codex",
    displayName: "Pixel (UI Engineer)",
    provider: "codex",
    role: "implementer",
    specialties: ["ui", "general"]
  },
  {
    id: "implementer-api-codex",
    displayName: "Forge (Backend Engineer)",
    provider: "codex",
    role: "implementer",
    specialties: ["api_crud", "business_logic", "general"]
  },
  {
    id: "reviewer-claude",
    displayName: "Lens (Code Reviewer)",
    provider: "claude",
    role: "reviewer",
    specialties: ["general", "ui", "business_logic", "api_crud"]
  },
  {
    id: "tester-codex",
    displayName: "Probe (Test Engineer)",
    provider: "codex",
    role: "tester",
    specialties: ["general", "ui", "business_logic", "api_crud"]
  }
];

export function createLiveAgents(options: AgentFactoryOptions): Agent[] {
  const invoker = options.invoker ?? new NodeCommandInvoker();

  return AGENT_SPECS.map((spec) => {
    const AgentClass = spec.provider === "claude" ? ClaudeCliAgent : CodexCliAgent;
    const model = spec.provider === "claude" ? options.claudeModel : options.codexModel;

    return new AgentClass({
      id: spec.id,
      name: spec.displayName,
      provider: spec.provider,
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

export async function registerAgentNames(): Promise<void> {
  for (const spec of AGENT_SPECS) {
    await setAgentName(spec.id, spec.displayName, spec.provider, spec.role);
  }
}

export { AGENT_SPECS };
