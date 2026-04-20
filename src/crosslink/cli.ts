import { CrosslinkStore } from "./store.js";
import { generateHookScripts, printHookSetupInstructions } from "./hook.js";
import { buildCrosslinkId } from "./types.js";

export async function handleCrosslinkCommand(
  subcommand: string,
  args: string[]
): Promise<void> {
  switch (subcommand) {
    case "init":
      return handleInit();
    case "status":
      return handleStatus();
    case "check":
      return handleCheck();
    case "send":
      return handleSend(args);
    case "clean":
      return handleClean();
    default:
      printHelp();
  }
}

async function handleInit(): Promise<void> {
  const { shellScriptPath } = await generateHookScripts();
  printHookSetupInstructions(shellScriptPath);
}

async function handleStatus(): Promise<void> {
  const store = new CrosslinkStore();
  const sessions = await store.discoverSessions();

  if (sessions.length === 0) {
    console.log("No active crosslink sessions.");
    return;
  }

  console.log(`Active crosslink sessions (${sessions.length}):`);
  console.log("");

  for (const session of sessions) {
    const age = timeSince(new Date(session.lastHeartbeat));
    console.log(`  ${session.sessionId}`);
    console.log(`    Repo:         ${session.repoPath}`);
    console.log(`    Provider:     ${session.agentProvider}`);
    console.log(`    Description:  ${session.description}`);
    console.log(`    Capabilities: ${session.capabilities.join(", ")}`);
    console.log(`    Status:       ${session.status}`);
    console.log(`    PID:          ${session.pid}`);
    console.log(`    Heartbeat:    ${age} ago`);
    console.log("");
  }
}

async function handleCheck(): Promise<void> {
  const store = new CrosslinkStore();
  const sessions = await store.discoverSessions();

  // Find session for current terminal — match by most recent heartbeat
  // In hook context, RELAY_SESSION / AGENT_HARNESS_SESSION is not set,
  // so we pick the most recently active session. The legacy env name is
  // accepted for back-compat with existing shell configs.
  const envSessionId = process.env.RELAY_SESSION ?? process.env.AGENT_HARNESS_SESSION;
  const session = envSessionId
    ? sessions.find((s) => s.sessionId === envSessionId)
    : sessions[0];

  if (!session) {
    return;
  }

  const messages = await store.pollMessages(session.sessionId);

  for (const msg of messages) {
    const replyHint = msg.type === "question"
      ? " — use crosslink_reply to respond"
      : "";

    console.log(`[CROSSLINK INBOUND from=${msg.fromSessionId} messageId=${msg.messageId} type=${msg.type}${replyHint}]`);
    console.log(msg.content);
    console.log("[/CROSSLINK]");
    console.log("");
  }
}

async function handleSend(args: string[]): Promise<void> {
  const toSessionId = args[0];
  const message = args.slice(1).join(" ");

  if (!toSessionId || !message) {
    console.error("Usage: rly crosslink send <sessionId> <message>");
    process.exitCode = 1;
    return;
  }

  const store = new CrosslinkStore();

  const sent = await store.sendMessage({
    fromSessionId: buildCrosslinkId("cli"),
    toSessionId,
    content: message,
    type: "question"
  });

  console.log(`Message sent: ${sent.messageId}`);
  console.log(`To: ${toSessionId}`);
}

async function handleClean(): Promise<void> {
  const store = new CrosslinkStore();

  // Discover sessions (auto-cleans stale ones)
  const sessions = await store.discoverSessions();
  const expired = await store.cleanExpiredMessages();

  console.log(`Active sessions: ${sessions.length}`);
  console.log(`Expired messages cleaned: ${expired}`);
}

function printHelp(): void {
  console.log("Usage: rly crosslink <subcommand>");
  console.log("");
  console.log("Subcommands:");
  console.log("  init     Generate hook scripts and print setup instructions");
  console.log("  status   List active crosslink sessions");
  console.log("  check    Poll for inbound messages (used by hooks)");
  console.log("  send     Send a message: crosslink send <sessionId> <message>");
  console.log("  clean    Remove stale sessions and expired messages");
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
