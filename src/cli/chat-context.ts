import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { ChannelStore } from "../channels/channel-store.js";
import { SessionStore } from "./session-store.js";

const HARNESS_DIR = join(homedir(), ".agent-harness");

export function buildSystemPrompt(input: {
  channelId: string;
  repoPath?: string;
  alias?: string;
}): string {
  const parts: string[] = [];

  if (input.repoPath && input.alias) {
    const repoName = input.repoPath.split("/").pop() ?? input.repoPath;
    parts.push(
      `You are working in the '${repoName}' repository (alias: @${input.alias}) at: ${input.repoPath}. ` +
      `Your working directory is already set to this repo — do NOT search for it elsewhere. ` +
      `All file operations should be relative to this directory.`
    );
  }

  const channelDir = join(HARNESS_DIR, "channels", input.channelId);
  const ticketsPath = join(channelDir, "tickets.json");
  const decisionsDir = join(channelDir, "decisions");

  parts.push(
    `\n\n## Shared Ticket Board & Decisions\n\n` +
    `Ticket board: \`${ticketsPath}\`\n` +
    `Decisions dir: \`${decisionsDir}/\`\n\n` +
    `IMPORTANT: When asked about tickets, always READ \`${ticketsPath}\` first. ` +
    `Do not guess or say tickets don't exist without checking the file.\n\n` +
    `When creating tickets, write them to \`${ticketsPath}\` as a JSON object with a \`tickets\` array. ` +
    `Each ticket: {"ticketId": "T-1", "title": "...", "specialty": "...", "status": "pending", ` +
    `"dependsOn": [], "assignedAgentId": null, "assignedAgentName": null, "verification": "...", "attempt": 0}\n\n` +
    `Status values: \`pending\` | \`blocked\` | \`executing\` | \`completed\` | \`failed\`\n` +
    `When starting a ticket set \`executing\`, when done set \`completed\`/\`failed\`. ` +
    `Always read-modify-write the whole file.\n\n` +
    `Decisions: write as JSON files in \`${decisionsDir}/\` with ` +
    `decisionId, title, description, rationale, alternatives, decidedByName, createdAt.`
  );

  return parts.join("\n");
}

export async function resolveChannelRefs(input: {
  message: string;
  currentChannelId: string;
}): Promise<{ resolved: string; refs: string[] }> {
  const channelStore = new ChannelStore();
  const sessionStore = new SessionStore();
  const channels = await channelStore.listChannels("active");
  const contextBlocks: string[] = [];
  const refs: string[] = [];
  const seen = new Set<string>();

  for (const word of input.message.split(/\s+/)) {
    if (!word.startsWith("#") || word.length < 2) {
      continue;
    }

    const refName = word
      .slice(1)
      .replace(/[.,;:!?]+$/, "");

    if (!refName || seen.has(refName)) {
      continue;
    }

    const refLower = refName.toLowerCase();
    const channel = channels.find(
      (ch) =>
        ch.name.toLowerCase() === refLower ||
        ch.name.toLowerCase().replace(/ /g, "-") === refLower
    );

    if (!channel) {
      continue;
    }

    seen.add(refName);
    refs.push(refName);

    // Load recent chat from most recent session
    const sessions = await sessionStore.listSessions(channel.channelId);

    if (sessions.length > 0) {
      const messages = await sessionStore.loadMessages(
        channel.channelId,
        sessions[0].sessionId,
        50
      );

      if (messages.length > 0) {
        let block = `\n\n---\n## Context from #${channel.name} channel\n\n`;

        for (const m of messages) {
          if (m.role === "activity") {
            continue;
          }

          const roleLabel = m.role === "user" ? "User" : m.role === "assistant" ? "Claude" : m.role;
          const content = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
          block += `**${roleLabel}**: ${content}\n\n`;
        }

        block += "---\n";
        contextBlocks.push(block);
      }

      // Include tickets if they exist
      const ticketsPath = join(HARNESS_DIR, "channels", channel.channelId, "tickets.json");

      if (existsSync(ticketsPath)) {
        try {
          const ticketContent = readFileSync(ticketsPath, "utf8");
          const truncated = ticketContent.length > 2000
            ? ticketContent.slice(0, 2000) + "..."
            : ticketContent;

          contextBlocks.push(
            `\n## Tickets from #${channel.name}\n\`\`\`json\n${truncated}\n\`\`\`\n`
          );
        } catch {
          // Skip if unreadable
        }
      }
    }
  }

  const resolved = contextBlocks.length > 0
    ? `${input.message}\n${contextBlocks.join("\n")}`
    : input.message;

  return { resolved, refs };
}

export function findMcpConfig(repoPath?: string): string | null {
  if (repoPath) {
    const path = join(repoPath, ".agent-harness", "claude.mcp.json");

    if (existsSync(path)) {
      return path;
    }
  }

  // Fallback: check cwd
  const cwdPath = join(process.cwd(), ".agent-harness", "claude.mcp.json");

  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  return null;
}
