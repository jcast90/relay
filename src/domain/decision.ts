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
}

export function buildDecisionId(): string {
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
