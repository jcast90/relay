import type { Agent } from "../domain/agent.js";

import { ClaudeCliAgent, CodexCliAgent } from "./cli-agents.js";
import { NodeCommandInvoker, type CommandInvoker } from "./command-invoker.js";

interface AgentFactoryOptions {
  cwd: string;
  invoker?: CommandInvoker;
  codexModel?: string;
  claudeModel?: string;
}

export function createLiveAgents(options: AgentFactoryOptions): Agent[] {
  const invoker = options.invoker ?? new NodeCommandInvoker();

  return [
    new ClaudeCliAgent({
      id: "planner-claude",
      name: "Planner Agent",
      provider: "claude",
      capability: {
        role: "planner",
        specialties: ["general"]
      },
      cwd: options.cwd,
      model: options.claudeModel,
      invoker
    }),
    new CodexCliAgent({
      id: "implementer-ui-codex",
      name: "UI Implementer Agent",
      provider: "codex",
      capability: {
        role: "implementer",
        specialties: ["ui", "general"]
      },
      cwd: options.cwd,
      model: options.codexModel,
      invoker
    }),
    new CodexCliAgent({
      id: "implementer-api-codex",
      name: "Backend Implementer Agent",
      provider: "codex",
      capability: {
        role: "implementer",
        specialties: ["api_crud", "business_logic", "general"]
      },
      cwd: options.cwd,
      model: options.codexModel,
      invoker
    }),
    new ClaudeCliAgent({
      id: "reviewer-claude",
      name: "Reviewer Agent",
      provider: "claude",
      capability: {
        role: "reviewer",
        specialties: ["general", "ui", "business_logic", "api_crud"]
      },
      cwd: options.cwd,
      model: options.claudeModel,
      invoker
    }),
    new CodexCliAgent({
      id: "tester-codex",
      name: "Tester Agent",
      provider: "codex",
      capability: {
        role: "tester",
        specialties: ["general", "ui", "business_logic", "api_crud"]
      },
      cwd: options.cwd,
      model: options.codexModel,
      invoker
    })
  ];
}
