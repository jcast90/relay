import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { CrosslinkStore } from "./store.js";
import type { CrosslinkCapability } from "./types.js";

export interface CrosslinkToolState {
  sessionId: string | null;
  store: CrosslinkStore;
}

export function getCrosslinkToolDefinitions(): object[] {
  return [
    {
      name: "crosslink_discover",
      description:
        "List active crosslink sessions across all repos. Use this to find other agent sessions you can collaborate with.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          capabilities: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "code_implementation",
                "code_review",
                "testing",
                "documentation",
                "architecture",
                "general"
              ]
            },
            description: "Optional filter: only show sessions with these capabilities."
          }
        }
      }
    },
    {
      name: "crosslink_send",
      description:
        "Send a message or question to another crosslink session. The receiving agent will see it in their next turn and can reply.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["toSessionId", "content"],
        properties: {
          toSessionId: {
            type: "string",
            description: "The session ID to send the message to."
          },
          content: {
            type: "string",
            description: "The message content (question, information, etc.)."
          },
          type: {
            type: "string",
            enum: ["question", "notification"],
            description: "Message type. Defaults to 'question'."
          }
        }
      }
    },
    {
      name: "crosslink_poll",
      description:
        "Check for inbound crosslink messages from other sessions. Returns pending messages and marks them as delivered.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  ];
}

export async function callCrosslinkTool(
  name: string,
  args: Record<string, unknown>,
  state: CrosslinkToolState
): Promise<unknown> {
  switch (name) {
    case "crosslink_register":
      return handleRegister(args, state);
    case "crosslink_discover":
      return handleDiscover(args, state);
    case "crosslink_send":
      return handleSend(args, state);
    case "crosslink_poll":
      return handlePoll(state);
    case "crosslink_reply":
      return handleReply(args, state);
    case "crosslink_deregister":
      return handleDeregister(state);
    default:
      return null;
  }
}

export function isCrosslinkTool(name: string): boolean {
  return name.startsWith("crosslink_");
}

async function handleRegister(
  args: Record<string, unknown>,
  state: CrosslinkToolState
): Promise<unknown> {
  if (!state.sessionId) {
    return { error: "Session not initialized. MCP server may not have auto-registered." };
  }

  const description = String(args.description ?? "");
  const capabilities = Array.isArray(args.capabilities)
    ? (args.capabilities as string[]).filter(isValidCapability)
    : undefined;

  const updated = await state.store.updateSession(state.sessionId, {
    description,
    ...(capabilities ? { capabilities } : {})
  });

  if (!updated) {
    return { error: "Session not found." };
  }

  return {
    sessionId: updated.sessionId,
    description: updated.description,
    capabilities: updated.capabilities
  };
}

async function handleDiscover(
  args: Record<string, unknown>,
  state: CrosslinkToolState
): Promise<unknown> {
  let sessions = await state.store.discoverSessions();

  const filterCapabilities = Array.isArray(args.capabilities)
    ? (args.capabilities as string[]).filter(isValidCapability)
    : null;

  if (filterCapabilities && filterCapabilities.length > 0) {
    sessions = sessions.filter((session) =>
      filterCapabilities.some((cap) =>
        session.capabilities.includes(cap as CrosslinkCapability)
      )
    );
  }

  return {
    currentSessionId: state.sessionId,
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      repoPath: session.repoPath,
      description: session.description,
      capabilities: session.capabilities,
      agentProvider: session.agentProvider,
      status: session.status,
      isSelf: session.sessionId === state.sessionId
    }))
  };
}

async function handleSend(
  args: Record<string, unknown>,
  state: CrosslinkToolState
): Promise<unknown> {
  if (!state.sessionId) {
    return { error: "Session not initialized." };
  }

  const toSessionId = String(args.toSessionId ?? "");
  const content = String(args.content ?? "");
  const type = args.type === "notification" ? "notification" as const : "question" as const;

  if (!toSessionId || !content) {
    return { error: "toSessionId and content are required." };
  }

  const message = await state.store.sendMessage({
    fromSessionId: state.sessionId,
    toSessionId,
    content,
    type
  });

  notifyTmux(toSessionId, state.sessionId);

  return {
    messageId: message.messageId,
    toSessionId: message.toSessionId,
    status: message.status
  };
}

async function handlePoll(state: CrosslinkToolState): Promise<unknown> {
  if (!state.sessionId) {
    return { error: "Session not initialized." };
  }

  const messages = await state.store.pollMessages(state.sessionId);

  return {
    count: messages.length,
    messages: messages.map((msg) => ({
      messageId: msg.messageId,
      fromSessionId: msg.fromSessionId,
      type: msg.type,
      content: msg.content,
      inReplyTo: msg.inReplyTo,
      createdAt: msg.createdAt
    }))
  };
}

async function handleReply(
  args: Record<string, unknown>,
  state: CrosslinkToolState
): Promise<unknown> {
  if (!state.sessionId) {
    return { error: "Session not initialized." };
  }

  const messageId = String(args.messageId ?? "");
  const content = String(args.content ?? "");

  if (!messageId || !content) {
    return { error: "messageId and content are required." };
  }

  const allMessages = await readMailboxMessages(state.store.rootDir, state.sessionId);
  const original = allMessages.find((msg) => msg.messageId === messageId);

  if (!original) {
    return { error: `Message not found: ${messageId}` };
  }

  const reply = await state.store.sendMessage({
    fromSessionId: state.sessionId,
    toSessionId: original.fromSessionId,
    content,
    type: "reply",
    inReplyTo: messageId
  });

  await state.store.updateMessageStatus(state.sessionId, messageId, "replied");

  notifyTmux(original.fromSessionId, state.sessionId);

  return {
    replyMessageId: reply.messageId,
    toSessionId: original.fromSessionId,
    inReplyTo: messageId
  };
}

async function handleDeregister(state: CrosslinkToolState): Promise<unknown> {
  if (!state.sessionId) {
    return { error: "Session not initialized." };
  }

  await state.store.deregisterSession(state.sessionId);
  const sessionId = state.sessionId;
  state.sessionId = null;

  return { deregistered: sessionId };
}

async function readMailboxMessages(
  storeRootDir: string,
  sessionId: string
): Promise<Array<{ messageId: string; fromSessionId: string }>> {
  const mailboxDir = join(storeRootDir, "mailboxes", sessionId);

  try {
    const files = await readdir(mailboxDir);
    const messages: Array<{ messageId: string; fromSessionId: string }> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      try {
        const raw = JSON.parse(await readFile(join(mailboxDir, file), "utf8")) as {
          messageId?: string;
          fromSessionId?: string;
        };

        if (raw.messageId && raw.fromSessionId) {
          messages.push({
            messageId: raw.messageId,
            fromSessionId: raw.fromSessionId
          });
        }
      } catch {
        // Skip malformed files
      }
    }

    return messages;
  } catch {
    return [];
  }
}

function notifyTmux(targetSessionId: string, fromSessionId: string): void {
  if (!process.env.TMUX) {
    return;
  }

  try {
    execFileSync("tmux", [
      "display-message",
      `Crosslink: message from ${fromSessionId} → ${targetSessionId}`
    ], { stdio: "ignore", timeout: 2000 });
  } catch {
    // tmux not available or failed
  }
}

const VALID_CAPABILITIES = new Set([
  "code_implementation",
  "code_review",
  "testing",
  "documentation",
  "architecture",
  "general"
]);

function isValidCapability(value: string): value is CrosslinkCapability {
  return VALID_CAPABILITIES.has(value);
}
