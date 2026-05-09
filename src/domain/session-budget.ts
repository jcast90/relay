import { z } from "zod";

/**
 * Schema version for SessionBudget. Bumping this requires a same-PR Rust
 * mirror update (`crates/harness-data/src/lib.rs::SessionBudget::schema_version`)
 * AND a forward-migration helper for any pre-existing on-disk lines.
 *
 * Phase 2's handoff brief artifacts depend on this contract being stable —
 * if you bump it, surface the change in the Phase 2 plan's revision_context.
 */
export const SESSION_BUDGET_SCHEMA_VERSION = 1 as const;

/**
 * Discriminator for the three keyspaces under `~/.relay/sessions/`:
 *   - "chat":  chat-mode sessions (recorded via `rly chat record-usage`)
 *   - "run":   orchestrator dispatches (recorded by OrchestratorV2.dispatch)
 *   - "admin": autonomous-loop admin sessions (existing keyspace under
 *              `admin-<alias>`); default when missing for back-compat
 *              with files that pre-date Phase 1.
 *
 * `list_chat_session_budgets()` and `loadActiveSessions()` filter on
 * `kind === "chat"` to avoid surfacing autonomous noise in the
 * worst-session chip / `rly status` block.
 */
export const SessionKindSchema = z.enum(["chat", "run", "admin"]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

/**
 * `SessionBudget` is the on-disk + cross-dashboard shape for per-session
 * token-budget snapshots. Mirrored at
 * `crates/harness-data/src/lib.rs::SessionBudget` — same-PR change
 * discipline (AGENTS.md > "Cross-dashboard contract").
 */
export const SessionBudgetSchema = z.object({
  schemaVersion: z.literal(SESSION_BUDGET_SCHEMA_VERSION),
  kind: SessionKindSchema.default("admin"),
  sessionId: z.string().min(1),
  used: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  pct: z.number().finite(),
  lastUpdated: z.string().optional(),
  modelName: z.string().optional(),
});

export type SessionBudget = z.infer<typeof SessionBudgetSchema>;
