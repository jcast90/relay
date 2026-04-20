import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ChannelStore } from "../channels/channel-store.js";
import { getHarnessStore } from "../storage/factory.js";
import { getRelayDir } from "./paths.js";
import { SessionStore } from "./session-store.js";

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

  const channelDir = join(getRelayDir(), "channels", input.channelId);
  const ticketsPath = join(channelDir, "tickets.json");
  const decisionsDir = join(channelDir, "decisions");

  parts.push(
    `\n\n## Shared Ticket Board & Decisions\n\n` +
    `Ticket board: \`${ticketsPath}\`\n` +
    `Decisions dir: \`${decisionsDir}/\`\n\n` +
    `IMPORTANT: When asked about tickets, always READ \`${ticketsPath}\` first. ` +
    `Do not guess or say tickets don't exist without checking the file.\n\n` +
    `This file is the unified board shared by chat and orchestrator runs. ` +
    `When creating tickets, write to \`${ticketsPath}\` as JSON: ` +
    `\`{"updatedAt": "<ISO-8601>", "tickets": [<TicketLedgerEntry>...]}\`. ` +
    `Each ticket must use the full TicketLedgerEntry shape: ` +
    `\`{"ticketId": "T-1", "title": "...", "specialty": "general"|"ui"|"business_logic"|"api_crud"|"devops"|"testing", ` +
    `"status": "pending"|"blocked"|"ready"|"executing"|"verifying"|"retry"|"completed"|"failed", ` +
    `"dependsOn": [], "assignedAgentId": null, "assignedAgentName": null, "crosslinkSessionId": null, ` +
    `"verification": "pending"|"running"|"passed"|"failed_recoverable"|"failed_terminal", ` +
    `"lastClassification": null, "chosenNextAction": null, "attempt": 0, ` +
    `"startedAt": null, "completedAt": null, "updatedAt": "<ISO-8601>", "runId": null}\`.\n\n` +
    `Set \`runId\` to null for chat-created tickets; the orchestrator fills it for run-decomposed tickets. ` +
    `When starting a ticket set \`status\` to \`executing\` and \`startedAt\` to now; ` +
    `when done set \`completed\`/\`failed\` and populate \`completedAt\`. ` +
    `Always read-modify-write the whole file and refresh \`updatedAt\` on every write.\n\n` +
    `Decisions: write as JSON files in \`${decisionsDir}/\` with ` +
    `decisionId, title, description, rationale, alternatives, decidedByName, createdAt.`
  );

  return parts.join("\n");
}

export async function resolveChannelRefs(input: {
  message: string;
  currentChannelId: string;
}): Promise<{ resolved: string; refs: string[] }> {
  const channelStore = new ChannelStore(undefined, getHarnessStore());
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
      const ticketsPath = join(getRelayDir(), "channels", channel.channelId, "tickets.json");

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
  // Prefer the new .relay/ directory; fall back to legacy .agent-harness/
  // so existing checkouts keep working until the user migrates.
  const candidates = ["relay", "agent-harness"];
  const roots = [repoPath, process.cwd()].filter((r): r is string => Boolean(r));

  for (const root of roots) {
    for (const dirName of candidates) {
      const candidate = join(root, `.${dirName}`, "claude.mcp.json");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}
