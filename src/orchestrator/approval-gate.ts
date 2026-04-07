import type { ArtifactStore } from "../execution/artifact-store.js";
import type { HarnessRun } from "../domain/run.js";

export interface ApprovalResult {
  decision: "approved" | "rejected";
  feedback?: string;
}

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 3_600_000;

export async function awaitApproval(input: {
  run: HarnessRun;
  artifactStore: ArtifactStore;
}): Promise<ApprovalResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const record = await input.artifactStore.readApprovalRecord(input.run.id);

    if (record) {
      return {
        decision: record.decision,
        feedback: record.feedback
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return {
    decision: "rejected",
    feedback: "Approval timed out after 1 hour."
  };
}

export async function submitApproval(input: {
  runId: string;
  decision: "approved" | "rejected";
  feedback?: string;
  artifactStore: ArtifactStore;
}): Promise<string> {
  return input.artifactStore.saveApprovalRecord({
    runId: input.runId,
    decision: input.decision,
    feedback: input.feedback
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
