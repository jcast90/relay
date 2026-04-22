import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ChannelStore } from "../channels/channel-store.js";
import type { Channel, RepoAssignment } from "../domain/channel.js";
import { getHarnessStore } from "../storage/factory.js";
import { getRelayDir } from "./paths.js";
import { SessionStore } from "./session-store.js";

/**
 * Best-effort repo context: git remote + branch + top-level tree + README
 * head. Returns an empty string when anything fails so we never block chat
 * startup on a git hiccup (repo deleted, not a git repo, etc.).
 */
function collectRepoContext(repoPath: string): string {
  const lines: string[] = [];
  const tryGit = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", repoPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
    } catch {
      return null;
    }
  };

  const remote = tryGit(["remote", "get-url", "origin"]);
  if (remote) lines.push(`Git remote: ${remote}`);
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) lines.push(`Current branch: ${branch}`);

  try {
    const entries = readdirSync(repoPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 20)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join(" ");
    if (entries) lines.push(`Top-level entries: ${entries}`);
  } catch {
    /* skip */
  }

  const readme = ["README.md", "README", "Readme.md", "readme.md"]
    .map((name) => join(repoPath, name))
    .find((p) => existsSync(p));
  if (readme) {
    try {
      const head = readFileSync(readme, "utf8").split("\n").slice(0, 10).join("\n").trim();
      if (head) lines.push(`README head:\n${head}`);
    } catch {
      /* skip */
    }
  }
  return lines.length > 0 ? lines.join("\n") : "";
}

/**
 * Read up to `limit` lines of AGENTS.md from a repo root. Checks common
 * case variants (`AGENTS.md`, `Agents.md`, `agents.md`) so we work on
 * case-sensitive filesystems without silently missing a differently-cased
 * file. Returns `null` when no variant exists or any read error occurs —
 * callers render a short placeholder in that case so the system prompt
 * never blows up on a missing doc.
 */
export function readAgentsMdSummary(repoPath: string, limit = 40): string | null {
  const variants = ["AGENTS.md", "Agents.md", "agents.md"];
  for (const name of variants) {
    const path = join(repoPath, name);
    if (!existsSync(path)) continue;
    try {
      const head = readFileSync(path, "utf8").split("\n").slice(0, limit).join("\n").trimEnd();
      return head.length > 0 ? head : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve the primary repo assignment for a channel. Prefers the repo whose
 * workspaceId matches `channel.primaryWorkspaceId` (set by Task #22 when the
 * user picks a primary in the GUI); falls back to the first assignment so
 * pre-migration channels and channels created before the field existed keep
 * working. Returns `null` only when there are no assignments at all.
 *
 * Inlined here instead of imported from `ChannelStore` so this file stays
 * the single source of truth for the primary/associated rule in the chat
 * prompt layer — and so we don't hard-depend on a helper that may not have
 * landed yet in a sibling task.
 */
function getPrimaryAssignment(channel: Channel): RepoAssignment | null {
  const assignments = channel.repoAssignments ?? [];
  if (assignments.length === 0) return null;
  const primaryWorkspaceId = (channel as Channel & { primaryWorkspaceId?: string })
    .primaryWorkspaceId;
  if (primaryWorkspaceId) {
    const match = assignments.find((r) => r.workspaceId === primaryWorkspaceId);
    if (match) return match;
  }
  return assignments[0] ?? null;
}

export async function buildSystemPrompt(input: {
  channelId: string;
  repoPath?: string;
  alias?: string;
}): Promise<string> {
  const parts: string[] = [];

  const channelStore = new ChannelStore();
  const channel = await channelStore.getChannel(input.channelId).catch(() => null);
  const assignments = channel?.repoAssignments ?? [];
  const primary = channel ? getPrimaryAssignment(channel) : null;

  if (channel && primary && assignments.length > 0) {
    const associated = assignments.filter((r) => r.workspaceId !== primary.workspaceId);

    // Role resolution: the session is "associated" only when an alias prefix
    // identifies one of the non-primary repos. Any other case (no alias, or
    // alias matches the primary) is treated as the primary role so the
    // default unprefixed chat continues to speak from the primary repo.
    const isAssociated = Boolean(
      input.alias &&
      assignments.some((r) => r.alias === input.alias && r.workspaceId !== primary.workspaceId)
    );

    if (isAssociated) {
      // input.alias is guaranteed truthy inside this branch; the `!` just
      // lets TS narrow without an extra conditional.
      const selfAlias = input.alias!;
      const self = assignments.find((r) => r.alias === selfAlias)!;
      const selfName = self.repoPath.split("/").pop() ?? self.repoPath;

      parts.push(
        `You are an associated agent for channel '${channel.name}', attached as \`@${selfAlias}\`. ` +
          `You work in \`${selfName}\` at: ${self.repoPath}. ` +
          `Your working directory is already set to this repo — do NOT search for it elsewhere. ` +
          `All file operations should be relative to this directory.`
      );

      const selfCtx = collectRepoContext(self.repoPath);
      if (selfCtx) {
        parts.push(
          "\nYour repo context (read at session start — may be stale after long runs):\n" + selfCtx
        );
      }

      parts.push(
        `\nPrimary agent: \`@${primary.alias}\` at ${primary.repoPath}. ` +
          `You may receive crosslink messages from them and should reply promptly.`
      );

      const channelDir = join(getRelayDir(), "channels", channel.channelId);
      const ticketsPath = join(channelDir, "tickets.json");
      parts.push(
        `\n### Ticket polling\n` +
          `Read \`${ticketsPath}\` at the start of every prompt. Tickets where ` +
          `\`assignedAlias === '${selfAlias}'\` and \`status === 'ready'\` are yours to work. ` +
          `Claim a ticket by setting \`status\` to \`executing\` and \`startedAt\` to the current ISO-8601 timestamp. ` +
          `When finished, set \`status\` to \`completed\` (or \`failed\` with a reason in your chat reply) and populate \`completedAt\`. ` +
          `Use the full TicketLedgerEntry shape documented in the "Shared Ticket Board" section below — do not invent new fields.`
      );
    } else {
      // Primary role — default for unprefixed chat and for explicit
      // @<primary-alias> prefixes.
      const primaryName = primary.repoPath.split("/").pop() ?? primary.repoPath;
      parts.push(
        `You are the primary agent for channel '${channel.name}'. ` +
          `You work in \`${primaryName}\` (alias: \`@${primary.alias}\`) at: ${primary.repoPath}. ` +
          `Your working directory is already set to this repo — do NOT search for it elsewhere. ` +
          `All file operations should be relative to this directory.`
      );

      const primaryCtx = collectRepoContext(primary.repoPath);
      if (primaryCtx) {
        parts.push(
          "\nPrimary repo context (read at session start — may be stale after long runs):\n" +
            primaryCtx
        );
      }

      if (associated.length > 0) {
        const blocks: string[] = [
          `\n### Associated repos`,
          `These repos are attached to the channel but you do NOT work in them directly. ` +
            `An associated agent is (or can be) attached to each one.`,
        ];
        for (const r of associated) {
          const aName = r.repoPath.split("/").pop() ?? r.repoPath;
          const summary = readAgentsMdSummary(r.repoPath);
          if (summary) {
            blocks.push(
              `\n- \`@${r.alias}\` — ${aName} at ${r.repoPath}\n` +
                `  AGENTS.md (first 40 lines):\n\n` +
                summary
                  .split("\n")
                  .map((line) => `  ${line}`)
                  .join("\n")
            );
          } else {
            blocks.push(
              `\n- \`@${r.alias}\` — ${aName} at ${r.repoPath}\n` +
                `  (no AGENTS.md found — primary agent may Read files directly if needed)`
            );
          }
        }

        blocks.push(
          `\n### Delegating to associated agents\n` +
            `For quick questions about an associated repo, use \`crosslink_send\` to message the agent there. ` +
            `For long-running or multi-step work, write a ticket to the channel's \`tickets.json\` with ` +
            `\`assignedAlias: '<alias>'\` set to the target associated repo's alias — the associated agent will pick it up on its next poll. ` +
            `Do NOT modify files in associated repos directly; delegate instead.`
        );

        parts.push(blocks.join("\n"));
      }
    }
  } else if (input.repoPath) {
    // Legacy single-repo path: no channel / no assignments, but an explicit
    // --repo was passed (e.g. from the TUI / CLI flow before channels were
    // created). Preserved verbatim from the pre-Task-#23 behavior.
    const repoName = input.repoPath.split("/").pop() ?? input.repoPath;
    if (input.alias) {
      parts.push(
        `You are working in the '${repoName}' repository (alias: @${input.alias}) at: ${input.repoPath}. ` +
          `Your working directory is already set to this repo — do NOT search for it elsewhere. ` +
          `All file operations should be relative to this directory.`
      );
    }
    const repoContext = collectRepoContext(input.repoPath);
    if (repoContext) {
      parts.push(
        (input.alias ? "\nRepo context" : "Current repo context") +
          " (read at session start — may be stale after long runs):\n" +
          repoContext
      );
    }
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
  const sessionStore = new SessionStore(undefined, getHarnessStore());
  const channels = await channelStore.listChannels("active");
  const contextBlocks: string[] = [];
  const refs: string[] = [];
  const seen = new Set<string>();

  for (const word of input.message.split(/\s+/)) {
    if (!word.startsWith("#") || word.length < 2) {
      continue;
    }

    const refName = word.slice(1).replace(/[.,;:!?]+$/, "");

    if (!refName || seen.has(refName)) {
      continue;
    }

    const refLower = refName.toLowerCase();
    const channel = channels.find(
      (ch) =>
        ch.name.toLowerCase() === refLower || ch.name.toLowerCase().replace(/ /g, "-") === refLower
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
          const truncated =
            ticketContent.length > 2000 ? ticketContent.slice(0, 2000) + "..." : ticketContent;

          contextBlocks.push(
            `\n## Tickets from #${channel.name}\n\`\`\`json\n${truncated}\n\`\`\`\n`
          );
        } catch {
          // Skip if unreadable
        }
      }
    }
  }

  const resolved =
    contextBlocks.length > 0 ? `${input.message}\n${contextBlocks.join("\n")}` : input.message;

  return { resolved, refs };
}

export function findMcpConfig(repoPath?: string): string | null {
  const roots = [repoPath, process.cwd()].filter((r): r is string => Boolean(r));

  for (const root of roots) {
    const candidate = join(root, ".relay", "claude.mcp.json");
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
