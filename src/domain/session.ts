export interface ChatSession {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  claudeSessionIds: Record<string, string>;
}

export interface PersistedChatMessage {
  role: string;
  content: string;
  timestamp: string;
  agentAlias: string | null;
  /** Free-form per-message metadata. Populated by the rewind feature with
   *  `rewindKey` on user turns. Optional for back-compat with transcripts
   *  written before the field existed. */
  metadata?: Record<string, string>;
}

export function buildSessionId(): string {
  return `sess-${Date.now()}`;
}
