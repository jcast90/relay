import type { ArtifactStore } from "../execution/artifact-store.js";

export interface ApprovalResult {
  decision: "approved" | "rejected";
  feedback?: string;
}

export async function checkApproval(input: {
  runId: string;
  artifactStore: ArtifactStore;
}): Promise<ApprovalResult | null> {
  const record = await input.artifactStore.readApprovalRecord(input.runId);

  if (!record) {
    return null;
  }

  return {
    decision: record.decision,
    feedback: record.feedback,
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
    feedback: input.feedback,
  });
}
