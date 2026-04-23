import type { Agent, AgentProvider, AgentRole } from "../domain/agent.js";
import type { AgentSpecialty } from "../domain/specialty.js";
import { setAgentName } from "../domain/agent-names.js";
import type { AgentRoleName } from "../mcp/role-allowlist.js";

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
    specialties: ["general"],
  },
  {
    id: "pixel",
    displayName: "Pixel (UI Engineer)",
    role: "implementer",
    specialties: ["ui", "general"],
  },
  {
    id: "forge",
    displayName: "Forge (Backend Engineer)",
    role: "implementer",
    specialties: ["api_crud", "business_logic", "general"],
  },
  {
    id: "lens",
    displayName: "Lens (Code Reviewer)",
    role: "reviewer",
    specialties: ["general", "ui", "business_logic", "api_crud"],
  },
  {
    id: "probe",
    displayName: "Probe (Test Engineer)",
    role: "tester",
    specialties: ["general", "ui", "business_logic", "api_crud"],
  },
];

interface AgentFactoryOptions {
  cwd: string;
  invoker?: CommandInvoker;
  defaultProvider?: AgentProvider;
  defaultModel?: string;
  overrides?: Record<string, { provider?: AgentProvider; model?: string }>;
  /**
   * Per-agent streaming hook. When supplied, the factory will pass it to each
   * Claude-provider agent so stdout lines can be fed to the CLI activity
   * renderer. The factory calls this for every spec so callers can scope the
   * renderer per-agent (e.g. label it with the agent's displayName).
   */
  onStreamLineFor?: (spec: AgentSpec) => ((line: string) => void) | undefined;
  /**
   * Per-channel "full access" opt-in (AL-0). Threaded through to every
   * constructed agent so `--dangerously-skip-permissions` (Claude) /
   * `--sandbox workspace-write --ask-for-approval never` (Codex) gets passed
   * without requiring callers to set `RELAY_AUTO_APPROVE`. Callers resolving
   * per-channel state (e.g. `dispatch()`) read `channel.fullAccess` once and
   * forward it here.
   */
  fullAccess?: boolean;
  /**
   * AL-11: apply a restricted role to EVERY agent produced by this factory.
   * Today the only configured role is `repo-admin`; additional roles opt in
   * via `src/mcp/role-allowlist.ts`. Passing this causes each CLI agent to:
   *   - set `RELAY_AGENT_ROLE=<role>` in the spawned provider subprocess
   *     (activates the MCP server's per-role allowlist for that session), and
   *   - receive `--disallowed-tools <names,…>` on the Claude CLI args for
   *     the built-ins denied to this role (Edit/Write/NotebookEdit/Bash for
   *     repo-admin). MCP-layer enforcement alone is cosmetic for those
   *     built-ins — they never round-trip through MCP.
   *
   * `undefined` (the default) preserves pre-AL-11 behaviour: no role, no
   * restriction, full tool surface. AL-12 is where a concrete spawner picks
   * which agent specs get `role: "repo-admin"`; AL-11 ships the wiring and
   * the tests so the surface is real rather than dead code.
   *
   * Independent of {@link fullAccess}: a repo-admin channel may legitimately
   * have full-access on and the restricted role on at the same time.
   */
  role?: AgentRoleName;
  /**
   * Provider-profile env overlay merged into every spawned agent's
   * subprocess env. Overrides same-named values from the parent shell so
   * a channel bound to a non-default profile can flip `ANTHROPIC_BASE_URL`
   * / `OPENAI_BASE_URL` / `ANTHROPIC_MODEL` / `HARNESS_AGENT_*_MODEL`
   * without mutating the operator's global environment.
   */
  envOverlay?: Record<string, string>;
  /**
   * Extra env-var names appended to each adapter's default pass-env list.
   * Used to forward the profile's `apiKeyEnvRef` so the CLI subprocess
   * can read its own auth token. Relay never dereferences the secret —
   * the name just gets added to the allowlist the invoker copies from
   * `process.env`.
   */
  extraPassEnv?: string[];
}

export function createLiveAgents(options: AgentFactoryOptions): Agent[] {
  const invoker = options.invoker ?? new NodeCommandInvoker();
  const defaultProvider = options.defaultProvider ?? "claude";

  return AGENT_SPECS.map((spec) => {
    const override = options.overrides?.[spec.id];
    const provider = override?.provider ?? spec.provider ?? defaultProvider;
    const model = override?.model ?? spec.model ?? options.defaultModel;
    const AgentClass = provider === "codex" ? CodexCliAgent : ClaudeCliAgent;
    // Only Claude supports tool_use stream-json today — passing this to
    // CodexCliAgent is harmless but ignored there.
    const onStreamLine = provider === "claude" ? options.onStreamLineFor?.(spec) : undefined;

    return new AgentClass({
      id: spec.id,
      name: spec.displayName,
      provider,
      capability: {
        role: spec.role,
        specialties: spec.specialties,
      },
      cwd: options.cwd,
      model,
      invoker,
      onStreamLine,
      fullAccess: options.fullAccess,
      role: options.role,
      envOverlay: options.envOverlay,
      extraPassEnv: options.extraPassEnv,
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
