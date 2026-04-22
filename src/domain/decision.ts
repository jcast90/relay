export interface Decision {
  decisionId: string;
  channelId: string;
  runId: string | null;
  ticketId: string | null;
  title: string;
  description: string;
  rationale: string;
  alternatives: string[];
  decidedBy: string;
  decidedByName: string;
  linkedArtifacts: string[];
  createdAt: string;
  /**
   * Optional category tag for decision-board filtering / search. Current
   * values in use:
   *   - `"autonomous_session_started"` — emitted by `rly run --autonomous`
   *     (AL-3) when an autonomous session is wired up. Payload details
   *     land in {@link metadata}.
   *
   * Back-compat: older decision files and callers that don't set this
   * field keep reading + writing correctly; consumers that filter by
   * `type` treat `undefined` as "untagged / general decision". The Rust
   * reader (`crates/harness-data/src/lib.rs`) uses `serde` with field
   * pruning, so the new field is harmless on that side.
   */
  type?: string;
  /**
   * Optional structured payload attached to a typed decision. Used by AL-3
   * to carry the full autonomous-session arg set (sessionId, budgetTokens,
   * maxHours, trust, allowedRepos, startedAt, command, invokedBy) so the
   * audit entry is complete without stuffing every field into the
   * rationale string. Values must be JSON-serializable.
   */
  metadata?: Record<string, unknown>;
}

export function buildDecisionId(): string {
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
