import { type Agent, type AgentRole, type WorkRequest, roleForWork } from "../domain/agent.js";
import type { AgentSpecialty } from "../domain/specialty.js";

export class AgentRegistry {
  private readonly agents: Agent[] = [];

  register(agent: Agent): void {
    this.agents.push(agent);
  }

  resolve(request: WorkRequest): Agent {
    const requiredRole = roleForWork(request.kind);
    const candidates = this.agents
      .filter((agent) => agent.capability.role === requiredRole)
      .map((agent) => ({
        agent,
        score: scoreAgent(agent.capability.role, agent.capability.specialties, request.specialty),
      }))
      .sort((left, right) => right.score - left.score);

    const match = candidates[0]?.agent;

    if (!match) {
      throw new Error(
        `No agent registered for role=${requiredRole} specialty=${request.specialty}`
      );
    }

    return match;
  }
}

function scoreAgent(
  _role: AgentRole,
  specialties: AgentSpecialty[],
  requestedSpecialty: AgentSpecialty
): number {
  let score = 10;

  if (specialties.includes(requestedSpecialty)) {
    score += 20;
  }

  if (specialties.includes("general")) {
    score += 5;
  }

  return score;
}
