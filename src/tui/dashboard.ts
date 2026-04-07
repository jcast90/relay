import { ChannelStore } from "../channels/channel-store.js";
import { listAgentNames } from "../domain/agent-names.js";
import type { Channel, ChannelEntry } from "../domain/channel.js";
import type { TicketLedgerEntry } from "../domain/ticket.js";
import { LocalArtifactStore } from "../execution/artifact-store.js";
import {
  getGlobalRoot,
  listRegisteredWorkspaces
} from "../cli/workspace-registry.js";
import {
  bold,
  boxBottom,
  boxRow,
  boxTop,
  clearScreen,
  cyan,
  dim,
  divider,
  getTerminalSize,
  green,
  hideCursor,
  magenta,
  moveTo,
  red,
  showCursor,
  statusColor,
  truncate,
  yellow
} from "./render.js";

const ACTIVE_RUN_STATES = new Set([
  "CLASSIFYING", "DRAFT_PLAN", "PLAN_REVIEW", "AWAITING_APPROVAL",
  "DESIGN_DOC", "PHASE_READY", "PHASE_EXECUTE", "TEST_FIX_LOOP",
  "REVIEW_FIX_LOOP", "TICKETS_EXECUTING", "TICKETS_COMPLETE"
]);

interface DashboardState {
  channels: Channel[];
  selectedChannelIndex: number;
  feed: ChannelEntry[];
  tickets: TicketLedgerEntry[];
  activeRuns: Array<{ runId: string; state: string; featureRequest: string; workspace: string }>;
  agents: Array<{ id: string; name: string; role: string; provider: string }>;
}

export async function startDashboard(): Promise<void> {
  const channelStore = new ChannelStore();

  const state: DashboardState = {
    channels: [],
    selectedChannelIndex: 0,
    feed: [],
    tickets: [],
    activeRuns: [],
    agents: []
  };

  hideCursor();
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const cleanup = () => {
    showCursor();
    clearScreen();
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "\u0003") {
      cleanup();
      return;
    }

    if (key === "j" || key === "\u001b[B") {
      state.selectedChannelIndex = Math.min(
        state.selectedChannelIndex + 1,
        state.channels.length - 1
      );
    }

    if (key === "k" || key === "\u001b[A") {
      state.selectedChannelIndex = Math.max(state.selectedChannelIndex - 1, 0);
    }

    refresh(state, channelStore);
  });

  // Initial load + render
  await refresh(state, channelStore);

  // Refresh every 3 seconds
  setInterval(() => refresh(state, channelStore), 3000);
}

async function refresh(state: DashboardState, channelStore: ChannelStore): Promise<void> {
  state.channels = await channelStore.listChannels("active");
  state.agents = (await listAgentNames()).map((a) => ({
    id: a.agentId,
    name: a.displayName,
    role: a.role,
    provider: a.provider
  }));

  const selectedChannel = state.channels[state.selectedChannelIndex];

  if (selectedChannel) {
    state.feed = await channelStore.readFeed(selectedChannel.channelId, 20);

    // Load tickets from linked runs
    state.tickets = [];
    const runLinks = await channelStore.readRunLinks(selectedChannel.channelId);

    for (const link of runLinks) {
      const store = buildArtifactStore(link.workspaceId);
      const tickets = await store.readTicketLedger(link.runId);
      if (tickets) state.tickets.push(...tickets);
    }
  } else {
    state.feed = [];
    state.tickets = [];
  }

  // Load active runs across workspaces
  state.activeRuns = [];
  const workspaces = await listRegisteredWorkspaces();

  for (const ws of workspaces) {
    const store = buildArtifactStore(ws.workspaceId);
    const runs = await store.readRunsIndex();

    for (const run of runs) {
      if (ACTIVE_RUN_STATES.has(run.state)) {
        state.activeRuns.push({
          runId: run.runId,
          state: run.state,
          featureRequest: run.featureRequest,
          workspace: ws.repoPath.split("/").pop() ?? ws.workspaceId
        });
      }
    }
  }

  draw(state);
}

function draw(state: DashboardState): void {
  clearScreen();
  const { rows, cols } = getTerminalSize();
  const leftWidth = Math.min(28, Math.floor(cols * 0.25));
  const rightWidth = Math.min(36, Math.floor(cols * 0.3));
  const centerWidth = cols - leftWidth - rightWidth - 2;

  let row = 1;

  // Header
  moveTo(row, 1);
  process.stdout.write(
    bold(cyan(" AGENT HARNESS ")) +
    dim(`  q=quit  j/k=navigate  refreshing every 3s`)
  );
  row += 2;

  // === LEFT PANEL: Channels + Agents ===
  const channelPanelHeight = Math.min(state.channels.length + 4, Math.floor(rows * 0.5));
  moveTo(row, 1);
  process.stdout.write(boxTop(leftWidth, "Channels"));

  for (let i = 0; i < Math.min(state.channels.length, channelPanelHeight - 3); i++) {
    const ch = state.channels[i];
    const selected = i === state.selectedChannelIndex;
    const prefix = selected ? cyan("▸ ") : "  ";
    const activeCount = ch.members.filter((m) => m.status === "active").length;
    const label = truncate(ch.name, leftWidth - 10);
    const content = `${prefix}${selected ? bold(label) : label} ${dim(`(${activeCount})`)}`;
    moveTo(row + 1 + i, 1);
    process.stdout.write(boxRow(content, leftWidth));
  }

  if (state.channels.length === 0) {
    moveTo(row + 1, 1);
    process.stdout.write(boxRow(dim("No channels"), leftWidth));
  }

  const channelEnd = row + Math.max(state.channels.length, 1) + 1;
  moveTo(channelEnd, 1);
  process.stdout.write(boxBottom(leftWidth));

  // Agents panel
  const agentStart = channelEnd + 1;
  moveTo(agentStart, 1);
  process.stdout.write(boxTop(leftWidth, "Agents"));

  for (let i = 0; i < state.agents.length; i++) {
    const agent = state.agents[i];
    const name = truncate(agent.name, leftWidth - 8);
    moveTo(agentStart + 1 + i, 1);
    process.stdout.write(boxRow(`${cyan(name)}`, leftWidth));
  }

  if (state.agents.length === 0) {
    moveTo(agentStart + 1, 1);
    process.stdout.write(boxRow(dim("No agents registered"), leftWidth));
  }

  moveTo(agentStart + Math.max(state.agents.length, 1) + 1, 1);
  process.stdout.write(boxBottom(leftWidth));

  // === CENTER PANEL: Feed ===
  const feedStart = row;
  const selectedChannel = state.channels[state.selectedChannelIndex];
  const feedTitle = selectedChannel ? selectedChannel.name : "Feed";
  const feedHeight = rows - feedStart - 2;

  moveTo(feedStart, leftWidth + 2);
  process.stdout.write(boxTop(centerWidth, feedTitle));

  if (state.feed.length === 0) {
    moveTo(feedStart + 1, leftWidth + 2);
    process.stdout.write(boxRow(dim("No messages yet"), centerWidth));
    moveTo(feedStart + 2, leftWidth + 2);
    process.stdout.write(boxBottom(centerWidth));
  } else {
    const visibleFeed = state.feed.slice(-(feedHeight - 2));

    for (let i = 0; i < visibleFeed.length; i++) {
      const entry = visibleFeed[i];
      const from = entry.fromDisplayName ?? "system";
      const typeIcon = feedIcon(entry.type);
      const time = entry.createdAt.slice(11, 19);
      const msg = truncate(entry.content, centerWidth - 30);
      const line = `${dim(time)} ${typeIcon} ${bold(from)}: ${msg}`;
      moveTo(feedStart + 1 + i, leftWidth + 2);
      process.stdout.write(boxRow(line, centerWidth));
    }

    moveTo(feedStart + visibleFeed.length + 1, leftWidth + 2);
    process.stdout.write(boxBottom(centerWidth));
  }

  // === RIGHT PANEL: Task Board ===
  const boardStart = row;
  moveTo(boardStart, leftWidth + centerWidth + 3);
  process.stdout.write(boxTop(rightWidth, "Task Board"));

  if (state.tickets.length === 0 && state.activeRuns.length === 0) {
    moveTo(boardStart + 1, leftWidth + centerWidth + 3);
    process.stdout.write(boxRow(dim("No active tickets"), rightWidth));
    moveTo(boardStart + 2, leftWidth + centerWidth + 3);
    process.stdout.write(boxBottom(rightWidth));
  } else {
    let boardRow = boardStart + 1;

    // Group tickets by status
    const groups = groupTicketsByStatus(state.tickets);
    const statusOrder = ["executing", "verifying", "ready", "blocked", "pending", "retry", "completed", "failed"];

    for (const status of statusOrder) {
      const tickets = groups[status];
      if (!tickets || tickets.length === 0) continue;

      moveTo(boardRow, leftWidth + centerWidth + 3);
      process.stdout.write(boxRow(
        `${statusColor(status.toUpperCase())} ${dim(`(${tickets.length})`)}`,
        rightWidth
      ));
      boardRow++;

      for (const ticket of tickets.slice(0, 3)) {
        const agent = ticket.assignedAgentName ? dim(` [${ticket.assignedAgentName}]`) : "";
        const label = truncate(ticket.title, rightWidth - 12);
        moveTo(boardRow, leftWidth + centerWidth + 3);
        process.stdout.write(boxRow(`  ${label}${agent}`, rightWidth));
        boardRow++;
      }

      if (tickets.length > 3) {
        moveTo(boardRow, leftWidth + centerWidth + 3);
        process.stdout.write(boxRow(dim(`  +${tickets.length - 3} more`), rightWidth));
        boardRow++;
      }
    }

    // Active runs
    if (state.activeRuns.length > 0) {
      moveTo(boardRow, leftWidth + centerWidth + 3);
      process.stdout.write(boxRow(divider(rightWidth - 2).slice(3, -3), rightWidth));
      boardRow++;

      moveTo(boardRow, leftWidth + centerWidth + 3);
      process.stdout.write(boxRow(bold("Active Runs"), rightWidth));
      boardRow++;

      for (const run of state.activeRuns.slice(0, 4)) {
        const label = truncate(run.featureRequest, rightWidth - 18);
        moveTo(boardRow, leftWidth + centerWidth + 3);
        process.stdout.write(boxRow(
          `  ${statusColor(run.state)} ${dim(label)}`,
          rightWidth
        ));
        boardRow++;
      }
    }

    moveTo(boardRow, leftWidth + centerWidth + 3);
    process.stdout.write(boxBottom(rightWidth));
  }

  // Status bar
  moveTo(rows, 1);
  const channelCount = state.channels.length;
  const ticketCount = state.tickets.length;
  const runCount = state.activeRuns.length;
  process.stdout.write(
    dim(` ${channelCount} channel(s)  ${ticketCount} ticket(s)  ${runCount} active run(s)  ${state.agents.length} agent(s)`)
  );
}

function feedIcon(type: string): string {
  switch (type) {
    case "message": return cyan("💬");
    case "decision": return yellow("⚖️");
    case "status_update": return magenta("📊");
    case "artifact": return green("📎");
    case "agent_joined": return green("→");
    case "agent_left": return red("←");
    case "run_started": return cyan("▶");
    case "run_completed": return green("✓");
    case "ref_added": return dim("🔗");
    default: return dim("·");
  }
}

function groupTicketsByStatus(
  tickets: TicketLedgerEntry[]
): Record<string, TicketLedgerEntry[]> {
  const groups: Record<string, TicketLedgerEntry[]> = {};

  for (const ticket of tickets) {
    if (!groups[ticket.status]) groups[ticket.status] = [];
    groups[ticket.status].push(ticket);
  }

  return groups;
}

function buildArtifactStore(workspaceId: string): LocalArtifactStore {
  return new LocalArtifactStore(
    `${getGlobalRoot()}/workspaces/${workspaceId}/artifacts`
  );
}
