import { z } from "zod";

export const AgentSpecialtySchema = z.enum([
  "general",
  "ui",
  "business_logic",
  "api_crud",
  "devops",
  "testing",
  // AL-11: `repo_admin` is the per-repo foreman role. Repo-admin sessions
  // coordinate worktrees, ticket routing, and PR merge sequencing but do NOT
  // implement code themselves. Full role definition (system prompt + MCP
  // tool allowlist) lives in `src/agents/repo-admin.ts`. Lifecycle wiring —
  // spawning / long-lived session — is AL-12.
  "repo_admin",
]);

export type AgentSpecialty = z.infer<typeof AgentSpecialtySchema>;
