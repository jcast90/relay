import { describe, expect, it } from "vitest";

import {
  getAgentName,
  listAgentNames,
  setAgentName
} from "../src/domain/agent-names.js";

describe("agent names", () => {
  it("sets and retrieves agent display names", async () => {
    await setAgentName("test-agent-1", "Test Agent One", "claude", "planner");

    const name = await getAgentName("test-agent-1");
    expect(name).toBe("Test Agent One");

    // Falls back to agentId for unknown agents
    const unknown = await getAgentName("nonexistent-agent");
    expect(unknown).toBe("nonexistent-agent");

    // Clean up
    const entries = await listAgentNames();
    expect(entries.some((e) => e.agentId === "test-agent-1")).toBe(true);

    // Overwrite
    await setAgentName("test-agent-1", "Updated Name", "claude", "reviewer");
    const updated = await getAgentName("test-agent-1");
    expect(updated).toBe("Updated Name");
  });
});
