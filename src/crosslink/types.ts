import { z } from "zod";

export function buildCrosslinkId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const CrosslinkCapabilitySchema = z.enum([
  "code_implementation",
  "code_review",
  "testing",
  "documentation",
  "architecture",
  "general"
]);

export type CrosslinkCapability = z.infer<typeof CrosslinkCapabilitySchema>;

export const AgentProviderSchema = z.enum(["claude", "codex", "unknown"]);

export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const SessionStatusSchema = z.enum(["active", "idle", "busy"]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const CrosslinkSessionSchema = z.object({
  sessionId: z.string(),
  pid: z.number(),
  repoPath: z.string(),
  description: z.string(),
  capabilities: z.array(CrosslinkCapabilitySchema),
  agentProvider: AgentProviderSchema,
  registeredAt: z.string(),
  lastHeartbeat: z.string(),
  status: SessionStatusSchema
});

export type CrosslinkSession = z.infer<typeof CrosslinkSessionSchema>;

export const MessageTypeSchema = z.enum(["question", "reply", "notification"]);

export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageStatusSchema = z.enum([
  "pending",
  "delivered",
  "replied",
  "expired"
]);

export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const CrosslinkMessageSchema = z.object({
  messageId: z.string(),
  fromSessionId: z.string(),
  toSessionId: z.string(),
  type: MessageTypeSchema,
  content: z.string(),
  inReplyTo: z.string().nullable(),
  status: MessageStatusSchema,
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  repliedAt: z.string().nullable()
});

export type CrosslinkMessage = z.infer<typeof CrosslinkMessageSchema>;
