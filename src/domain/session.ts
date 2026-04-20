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
}

export function buildSessionId(): string {
  return `sess-${Date.now()}`;
}
