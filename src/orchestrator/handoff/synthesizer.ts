/**
 * Pure-over-declared-inputs handoff brief synthesizer.
 *
 * The function consumes `~/.relay/` data plus an explicit `now` and an
 * injectable `channelStore` / `artifactStore`. It does NOT call
 * `Date.now()`, `Math.random()`, or `process.env` directly.
 *
 * The ONE declared side effect is the v1 files-touched enrichment, which
 * shells out via `git log` (D-02). It can be disabled via
 * `options.gitLogEnabled = false` for strict bit-identicality assertions.
 * See `docs/design/handoff-brief.md` §Determinism caveats (added in Wave 5).
 *
 * Section ordering, per RESEARCH Q1 — render layer mirrors this:
 *   1. Status snapshot
 *   2. Mission
 *   3. Ticket DAG
 *   4. Recent decisions
 *   5. Files touched
 *   6. Working memory (agent-authored or placeholder)
 */

import { createHash } from "node:crypto";

import { ChannelStore } from "../../channels/channel-store.js";
import type { Channel, ChannelEntry, ChannelRunLink } from "../../domain/channel.js";
import type { Decision } from "../../domain/decision.js";
import {
  type TicketDefinition,
  type TicketLedgerEntry,
  linearizeTickets,
  validateTicketDag,
} from "../../domain/ticket.js";
import { getFilesTouchedByTicket } from "./files-touched.js";
import { readLatestGapFill } from "./persistence.js";
import { estimateTokens } from "./token-estimate.js";
import {
  BRIEF_TOKEN_BUDGETS,
  type BriefSection,
  type BuildBriefOptions,
  HANDOFF_BRIEF_SCHEMA_VERSION,
  type HandoffBrief,
} from "./types.js";

const GAP_FILL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour, per RESEARCH Pitfall 3

export async function buildBrief(options: BuildBriefOptions): Promise<HandoffBrief> {
  const channelStore = options.channelStore ?? new ChannelStore();
  const channelId = options.channelId;
  const now = options.now;
  const budget = options.tokenBudget ?? BRIEF_TOKEN_BUDGETS;
  const gitLogEnabled = options.gitLogEnabled !== false;

  // Read all the channel surfaces in parallel — they're independent on
  // disk and the synthesizer never mutates anything.
  const [channel, feed, tickets, decisions, runLinks] = await Promise.all([
    channelStore.getChannel(channelId),
    channelStore.readFeed(channelId),
    channelStore.readChannelTickets(channelId),
    channelStore.listDecisions(channelId),
    channelStore.readRunLinks(channelId),
  ]);

  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const briefId = buildBriefId(channelId, now);

  // Resolve the gap-fill: if the caller passed one explicitly we honor it
  // (including `null`, which opts out of disk lookup); otherwise auto-load
  // the newest non-stale `<briefId>.gap.json` from
  // `~/.relay/channels/<id>/handoffs/`. PR-2 wires this so a gap written
  // via `channel_handoff_finalize` flows into the next brief without the
  // caller threading it through. Stale records (>1h) and any record with
  // `schemaVersion !== 1` are filtered by `readLatestGapFill` itself
  // (M9 fail-closed).
  const gapFill =
    options.gapFill !== undefined ? options.gapFill : await readLatestGapFill(channelId, { now });

  // Build each section. Truncation is per-section, newest-first
  // preservation, with `truncated = true` set when oldest items are
  // dropped to fit the budget.
  const statusSnapshot = renderStatusSnapshot(channel, feed, runLinks, budget.statusSnapshot);
  const mission = renderMission(channel, budget.mission);
  const ticketDag = renderTicketDag(tickets, budget.ticketDag);
  const recentDecisions = renderRecentDecisions(decisions, budget.recentDecisions);
  const filesTouched = await renderFilesTouched(
    channelId,
    channel,
    tickets,
    options.repoCwds ?? deriveRepoCwds(channel),
    budget.filesTouched,
    gitLogEnabled
  );
  const workingMemory = renderWorkingMemory(gapFill ?? null, now, budget.workingMemory);

  const tokenEstimate =
    statusSnapshot.estimatedTokens +
    mission.estimatedTokens +
    ticketDag.estimatedTokens +
    recentDecisions.estimatedTokens +
    filesTouched.estimatedTokens +
    workingMemory.estimatedTokens;

  return {
    schemaVersion: HANDOFF_BRIEF_SCHEMA_VERSION,
    briefId,
    channelId,
    channelName: channel.name,
    generatedAt: now.toISOString(),
    fromProvider: options.fromProvider ?? null,
    fromSessionId: options.fromSessionId ?? null,
    toHint: options.toHint ?? null,
    ...(options.resumedFrom ? { resumedFrom: options.resumedFrom } : {}),
    sections: {
      statusSnapshot,
      mission,
      ticketDag,
      recentDecisions,
      filesTouched,
      workingMemory,
    },
    tokenEstimate,
  };
}

/**
 * Generate a `brief-<unix-ms>-<6-char-base36>` id deterministically from
 * `(channelId, now)`. Uses sha-256 of `${channelId}:${now.toISOString()}`
 * sliced to 6 hex chars (lowercase, base16 ⊂ base36) so the synthesizer
 * stays pure under fixed inputs. Exported so the persistence layer (Wave 2)
 * can mint compatible ids for `channel_handoff_finalize`.
 */
export function buildBriefId(channelId: string, now: Date): string {
  const ms = now.getTime();
  const hash = createHash("sha256")
    .update(`${channelId}:${now.toISOString()}`)
    .digest("hex")
    .slice(0, 6);
  return `brief-${ms}-${hash}`;
}

// --- Section builders ---

function renderStatusSnapshot(
  channel: Channel,
  feed: ChannelEntry[],
  runLinks: ChannelRunLink[],
  budget: number
): BriefSection {
  const tier = channel.tier ?? "(untiered)";
  const kind = channel.kind ?? "channel";
  const repos = (channel.repoAssignments ?? []).map((a) => `${a.alias} (${a.repoPath})`).join(", ");
  const reposLine = repos.length > 0 ? repos : "(none)";

  // "Active runs" = run links without endedAt — but the run link record
  // doesn't carry endedAt. Treat all linked runs as active for the
  // snapshot; the deeper run-status surfaces are out of scope for v1.
  const activeRuns = runLinks.map((r) => r.runId);
  const activeRunsLine =
    activeRuns.length === 0
      ? "(none)"
      : `${activeRuns.length} (${activeRuns.slice(0, 5).join(", ")}${
          activeRuns.length > 5 ? ", …" : ""
        })`;

  const lastActivity = feed.length > 0 ? feed[feed.length - 1].createdAt : "(no feed entries)";

  const body =
    `Tier: ${tier}\n` +
    `Kind: ${kind}\n` +
    `Repos: ${reposLine}\n` +
    `Active runs: ${activeRunsLine}\n` +
    `Last activity: ${lastActivity}`;

  return finalizeSection("Status snapshot", body, budget);
}

function renderMission(channel: Channel, budget: number): BriefSection {
  const description = (channel.description ?? "").slice(0, 1024);
  const body = description.length > 0 ? description : "(no mission set)";
  return finalizeSection("Mission", body, budget);
}

function renderTicketDag(tickets: TicketLedgerEntry[], budget: number): BriefSection {
  if (tickets.length === 0) {
    return finalizeSection("Ticket DAG", "(no tickets)", budget);
  }

  // newest-first by updatedAt for truncation preservation
  const newestFirst = [...tickets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cap = Math.min(30, newestFirst.length);
  const slice = newestFirst.slice(0, cap);

  // Build a synthetic TicketDefinition shape for validateTicketDag — it
  // only reads `id` and `dependsOn`. Other fields are dummy-filled.
  const synthetic: TicketDefinition[] = slice.map((t) => ({
    id: t.ticketId,
    title: t.title,
    objective: "",
    specialty: t.specialty,
    acceptanceCriteria: ["_"],
    allowedCommands: [],
    verificationCommands: [],
    docsToUpdate: [],
    dependsOn: t.dependsOn ?? [],
    retryPolicy: { maxAgentAttempts: 1, maxTestFixLoops: 1 },
  }));

  const dagResult = validateTicketDag(synthetic);
  let orderedIds: string[];
  let cycleWarning = false;
  if (dagResult.valid) {
    orderedIds = dagResult.order;
  } else {
    cycleWarning = true;
    orderedIds = linearizeTickets(synthetic).map((t) => t.id);
  }

  const byId = new Map(slice.map((t) => [t.ticketId, t]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((t): t is TicketLedgerEntry => !!t);

  // Build a markdown table. Truncation: drop oldest entries (end of the
  // newest-first ordered list — i.e., we shave from the back of the
  // topo-sorted slice that holds the oldest tickets).
  const header = `| ID | Title | Status | Specialty | Depends on | Updated |\n| --- | --- | --- | --- | --- | --- |`;

  const truncatedRows = [...ordered];
  const buildBody = () => {
    const rows = truncatedRows.map(
      (t) =>
        `| ${t.ticketId} | ${escapeMd(t.title)} | ${t.status} | ${t.specialty} | ${
          (t.dependsOn ?? []).join(",") || "—"
        } | ${t.updatedAt} |`
    );
    let body = `${header}\n${rows.join("\n")}`;
    if (cycleWarning) {
      body += `\n\n> Warning: ticket dependency cycle detected; rendered in linear order.`;
    }
    return body;
  };

  let body = buildBody();
  let truncated = false;
  while (truncatedRows.length > 1 && estimateTokens(body) > budget) {
    truncatedRows.pop();
    truncated = true;
    body = buildBody();
  }

  const section = finalizeSection("Ticket DAG", body, budget);
  if (truncated) section.truncated = true;
  return section;
}

function renderRecentDecisions(decisions: Decision[], budget: number): BriefSection {
  if (decisions.length === 0) {
    return finalizeSection("Recent decisions", "(none recorded)", budget);
  }

  // listDecisions returns newest-first.
  const recent = decisions.slice(0, 5);
  const older = decisions.slice(5);

  const buildBody = (recentSlice: Decision[], olderSlice: Decision[]) => {
    const recentRendered = recentSlice
      .map((d) => {
        const alts =
          d.alternatives.length === 0
            ? "Alternatives: (none recorded)"
            : `Alternatives:\n${d.alternatives.map((a) => `  - ${a}`).join("\n")}`;
        return [
          `### ${d.title}`,
          `*${d.createdAt}* — ${d.decidedByName}`,
          `${d.description}`,
          `Rationale: ${d.rationale}`,
          alts,
        ].join("\n");
      })
      .join("\n\n");

    const olderRendered =
      olderSlice.length > 0
        ? `\n\n#### Older decisions\n${olderSlice
            .map((d) => `- ${d.title} *(${d.createdAt})*`)
            .join("\n")}`
        : "";

    return `${recentRendered}${olderRendered}`;
  };

  let recentSlice = [...recent];
  let olderSlice = [...older];
  let body = buildBody(recentSlice, olderSlice);
  let truncated = false;
  // Truncation: drop older summaries first, then drop oldest recent
  // entries (end of `recentSlice`).
  while (estimateTokens(body) > budget) {
    if (olderSlice.length > 0) {
      olderSlice = [];
      truncated = true;
    } else if (recentSlice.length > 1) {
      recentSlice.pop();
      truncated = true;
    } else {
      break;
    }
    body = buildBody(recentSlice, olderSlice);
  }

  const section = finalizeSection("Recent decisions", body, budget);
  if (truncated) section.truncated = true;
  return section;
}

async function renderFilesTouched(
  channelId: string,
  channel: Channel,
  tickets: TicketLedgerEntry[],
  repoCwds: string[],
  budget: number,
  gitLogEnabled: boolean
): Promise<BriefSection> {
  void channel;
  if (!gitLogEnabled || repoCwds.length === 0 || tickets.length === 0) {
    return finalizeSection("Files touched", "(no files-touched data)", budget);
  }

  const perTicket: Array<{ ticketId: string; files: string[] }> = [];
  // newest-first by updatedAt so truncation drops oldest tickets
  const newestFirst = [...tickets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const t of newestFirst) {
    const files = await getFilesTouchedByTicket(channelId, t.ticketId, repoCwds, {
      enabled: gitLogEnabled,
    });
    if (files.length > 0) perTicket.push({ ticketId: t.ticketId, files });
  }

  const buildBody = (rows: typeof perTicket) => {
    if (rows.length === 0) return "(no files-touched data)";
    return rows
      .map((r) => `**${r.ticketId}**:\n${r.files.map((f) => `  - ${f}`).join("\n")}`)
      .join("\n\n");
  };

  let trimmed = [...perTicket];
  let body = buildBody(trimmed);
  let truncated = false;
  while (trimmed.length > 1 && estimateTokens(body) > budget) {
    trimmed.pop();
    truncated = true;
    body = buildBody(trimmed);
  }

  const section = finalizeSection("Files touched", body, budget);
  if (truncated) section.truncated = true;
  return section;
}

function renderWorkingMemory(
  gapFill: BuildBriefOptions["gapFill"],
  now: Date,
  budget: number
): BriefSection {
  if (!gapFill) {
    return finalizeSection("Working memory", placeholderWorkingMemory(), budget);
  }

  const capturedAt = new Date(gapFill.capturedAt).getTime();
  if (Number.isNaN(capturedAt) || now.getTime() - capturedAt > GAP_FILL_MAX_AGE_MS) {
    // Stale gap.json: render placeholder per M5 / RESEARCH Pitfall 3.
    return finalizeSection("Working memory", placeholderWorkingMemory(), budget);
  }

  const abandoned =
    gapFill.abandonedApproaches.length === 0
      ? "(none recorded)"
      : gapFill.abandonedApproaches.map((a) => `  - ${a}`).join("\n");
  const open =
    gapFill.openQuestions.length === 0
      ? "(none recorded)"
      : gapFill.openQuestions.map((q) => `  - ${q}`).join("\n");

  const body = [
    `**Current line of attack:** ${gapFill.currentLineOfAttack || "(empty)"}`,
    `**Active hypothesis:** ${gapFill.activeHypothesis || "(empty)"}`,
    `**Abandoned approaches:**\n${abandoned}`,
    `**Open questions:**\n${open}`,
  ].join("\n\n");

  return finalizeSection("Working memory", body, budget);
}

function placeholderWorkingMemory(): string {
  return (
    "[gap-fill not provided]\n\n" +
    "> The departing agent did not author working-memory context. The " +
    "destination session will need to re-derive line-of-attack from the " +
    "deterministic sections above."
  );
}

// --- Helpers ---

function finalizeSection(heading: string, body: string, _budget: number): BriefSection {
  return {
    heading,
    body,
    estimatedTokens: estimateTokens(body),
  };
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function deriveRepoCwds(channel: Channel): string[] {
  const cwds = (channel.repoAssignments ?? []).map((a) => a.repoPath).filter(Boolean);
  return Array.from(new Set(cwds));
}
