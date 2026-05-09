import type { TokenUsage } from "../domain/agent.js";

/**
 * Mutable state passed between successive `processStreamLine` calls during
 * a Claude streaming invocation. Lives in `src/agents/` as a dedicated
 * module so the adapter (`cli-agents.ts`) can `import { processStreamLine
 * } from "./process-stream-line.js"` without growing the monolithic
 * adapter file. PR-2 (Task 3) lifts the existing closure body in
 * `invokeStreaming` into this function verbatim and adds the `obj.usage`
 * capture on the `result` arm.
 */
export interface StreamParseState {
  accumText: string;
  resultText: string | null;
  capturedUsage: TokenUsage | null;
}

/**
 * **Phase 1 PR-1:** stub. The pure function ships in PR-2 (Task 3); the
 * signature lands in PR-1 so the RED Claude streaming-usage test
 * (`test/agents/cli-agents-claude-usage.test.ts`) compiles against the
 * final shape.
 */
export function processStreamLine(
  _line: string,
  _state: StreamParseState,
  _onLine: (line: string) => void
): void {
  throw new Error("processStreamLine: not yet implemented (Phase 1 PR-2 / Task 3)");
}
