/**
 * Inline suggestion card shown at the top of general-channel feeds.
 *
 * Premise: general channels are for informal chat before the work
 * crystallises. When a user's INITIAL substantive message lands, we
 * offer to spin it out into a dedicated feature channel — the
 * classifier on the new channel takes it from a focused starting
 * point instead of a noisy general-chat backlog.
 *
 * Trigger heuristics (intentionally simple — no LLM round-trip):
 *   - channel name matches /^general$/i (the section anchor)
 *   - FIRST user-role session message has content ≥ 60 chars
 *   - user hasn't dismissed this specific turn (localStorage)
 *
 * Input source is `sessionMessages`, not the channel feed. Real
 * user chat goes through `startChat` → session append; feed entries
 * are dominated by agent / MCP / status_update writes, so a
 * feed-based check would (a) silently miss user content and (b) fire
 * on agent posts, which code-review #126 caught. The session log is
 * the authoritative "what did the user actually type" store.
 *
 * The action opens the new-channel modal with the message content
 * pre-filled as kickoff and the current channel's section pre-
 * selected. The modal handles the actual create + assign flow.
 */

import { useEffect, useMemo, useState } from "react";
import type { Channel, PersistedChatMessage } from "../types";

const MIN_LEN = 60;
const DISMISS_KEY = "relay.spinout.dismissed:all";
const DISMISS_LRU_CAP = 500;

type Props = {
  channel: Channel;
  sessionMessages: PersistedChatMessage[];
  onSpinout: (kickoff: string) => void;
};

export function SpinoutSuggestion({ channel, sessionMessages, onSpinout }: Props) {
  const candidate = useMemo(
    () => pickCandidate(channel, sessionMessages),
    [channel, sessionMessages]
  );
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readDismissed());

  useEffect(() => {
    setDismissedIds(readDismissed());
  }, [channel.channelId]);

  if (!candidate) return null;
  if (dismissedIds.has(candidate.key)) return null;

  const preview = candidate.message.content.trim().slice(0, 140).replace(/\s+/g, " ");
  const truncated = candidate.message.content.length > 140 ? `${preview}…` : preview;

  const dismiss = () => {
    const next = new Set(dismissedIds);
    next.add(candidate.key);
    writeDismissed(next);
    setDismissedIds(next);
  };

  return (
    <div className="spinout-card">
      <span className="spinout-icon" aria-hidden>
        ✦
      </span>
      <div className="spinout-body">
        <div className="spinout-title">Looks like real work — spin this out?</div>
        <div className="spinout-preview">{truncated}</div>
      </div>
      <div className="spinout-actions">
        <button
          type="button"
          className="primary"
          onClick={() => onSpinout(candidate.message.content)}
          title="Open new-channel modal with this message pre-filled"
        >
          Spin out →
        </button>
        <button type="button" className="spinout-dismiss" onClick={dismiss} title="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}

type Candidate = { key: string; message: PersistedChatMessage };

/**
 * Return the FIRST user-role message with ≥ 60 chars in the session
 * log, or null. Keyed by channelId + timestamp so dismissal survives
 * reloads and doesn't accidentally suppress a later turn with the
 * same text. Iterates forward on purpose — review #126 flagged that
 * a backward walk would mask the initial kickoff once the channel
 * has accumulated chatter.
 */
function pickCandidate(channel: Channel, messages: PersistedChatMessage[]): Candidate | null {
  const isGeneral = /^general$/i.test(channel.name.trim());
  if (!isGeneral) return null;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (m.content.trim().length < MIN_LEN) continue;
    return { key: `${channel.channelId}:${m.timestamp}`, message: m };
  }
  return null;
}

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissed(set: Set<string>): void {
  try {
    // Cap at DISMISS_LRU_CAP — oldest entries drop out so a long-running
    // user's storage doesn't grow unbounded over months of use. Order
    // preserved by the Set (insertion), newest at the tail.
    const arr = [...set];
    const trimmed = arr.length > DISMISS_LRU_CAP ? arr.slice(-DISMISS_LRU_CAP) : arr;
    localStorage.setItem(DISMISS_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage blocked — best-effort */
  }
}
