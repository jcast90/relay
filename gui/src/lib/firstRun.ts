/**
 * First-run seeder — runs on GUI boot.
 *
 * Behavior: if both the sections list and the channels list come back
 * empty, create a "Workspace" section and a "#general" channel in it,
 * and post a welcome message as the channel's first feed entry. After
 * that, later boots see existing data and skip.
 *
 * The check is idempotent by observation, not by flag: we never persist
 * a "did seed" bit because the absence of sections + channels is a
 * stronger signal than a localStorage entry (which resets on OS /
 * browser cache wipes).
 */

import { api } from "../api";

const WELCOME_MESSAGE = `👋 Welcome to Relay.

This is your **general** channel — a place to start conversations before they graduate into dedicated feature channels.

Quick start:
- Type \`@\` to ping a repo agent. New workspaces show up here after \`rly up\` in a repo dir.
- When a conversation turns into real work, Relay can suggest spinning it out into a new channel.
- Create more sections from the sidebar's \`+ New section\` button to group related channels (e.g. "TuringOn", "Experiments").

Tips:
- \`Cmd+Enter\` sends a message.
- Type \`/new\` in a DM to promote it to a full channel.
- Settings live in the sidebar footer gear.

Have fun.`;

export async function maybeSeedFirstRun(): Promise<boolean> {
  try {
    const [sections, channels] = await Promise.all([
      api.listSections(),
      api.listChannels(true),
    ]);
    if (sections.length > 0 || channels.length > 0) return false;

    const section = await api.createSection("Workspace");
    const created = await api.createChannel(
      "general",
      "General discussion — start here before spinning out features.",
      [],
      undefined
    );
    await api.assignChannelSection(created.channelId, section.sectionId);
    await api
      .postToChannel(created.channelId, WELCOME_MESSAGE, "Relay", "status_update")
      .catch((err) => console.warn("[first-run] welcome post failed:", err));
    return true;
  } catch (err) {
    console.warn("[first-run] seed failed:", err);
    return false;
  }
}
