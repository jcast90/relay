import { describe, expect, it } from "vitest";

import { createLiveAgents } from "../src/agents/factory.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { ScriptedInvoker } from "../src/simulation/scripted-invoker.js";

describe("agent registry", () => {
  it("prefers specialty matches for implementation work", () => {
    const registry = new AgentRegistry();
    const cwd = process.cwd();

    for (const agent of createLiveAgents({
      cwd,
      invoker: new ScriptedInvoker(cwd)
    })) {
      registry.register(agent);
    }

    const uiAgent = registry.resolve({
      runId: "run-1",
      phaseId: "phase-1",
      kind: "implement_phase",
      specialty: "ui",
      title: "Build UI shell",
      objective: "Create the first screen",
      acceptanceCriteria: ["Render the first screen"],
      allowedCommands: ["pnpm typecheck"],
      verificationCommands: ["pnpm typecheck"],
      docsToUpdate: [],
      context: [],
      artifactContext: [],
      attempt: 1,
      maxAttempts: 2,
      priorEvidence: []
    });

    const apiAgent = registry.resolve({
      runId: "run-1",
      phaseId: "phase-2",
      kind: "implement_phase",
      specialty: "api_crud",
      title: "Build API seams",
      objective: "Create service boundaries",
      acceptanceCriteria: ["Create service seams"],
      allowedCommands: ["pnpm typecheck"],
      verificationCommands: ["pnpm typecheck"],
      docsToUpdate: [],
      context: [],
      artifactContext: [],
      attempt: 1,
      maxAttempts: 2,
      priorEvidence: []
    });

    expect(uiAgent.id).toBe("implementer-ui-codex");
    expect(apiAgent.id).toBe("implementer-api-codex");
  });
});
