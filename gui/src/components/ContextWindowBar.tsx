import { tokenPctSeverity } from "../lib/tokenSeverity";

export interface ContextWindowBarProps {
  used: number;
  total: number;
  sessionId: string;
  model?: string;
}

/**
 * GUI percent-bar React component, severity-colored, polled per
 * App-level `refreshTick`.
 *
 * **Phase 1 PR-1:** stub. Implementation lands in PR-3 (Task 7). The
 * shape ships in PR-1 so the RED `ContextWindowBar.test.tsx` compiles
 * against the final props shape. The stub returns null at runtime so
 * tests that assert on the rendered output go RED loudly.
 */
export function ContextWindowBar(_props: ContextWindowBarProps) {
  // Reference tokenPctSeverity so tree-shaking does not strip the
  // import — Task 7's implementation will use it for the severity
  // class.
  void tokenPctSeverity;
  return null;
}
