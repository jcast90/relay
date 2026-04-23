/**
 * Inline suggestion card shown at the top of general-channel feeds.
 *
 * Premise: general channels are for informal chat before the work
 * crystallises. When a user posts something substantial, offer to
 * spin it out into a dedicated feature channel — the classifier can
 * then take the kickoff message from a focused starting point.
 *
 * Trigger heuristics (intentionally simple — no LLM round-trip):
 *   - channel name matches /^general$/i (the section anchor)
 *   - at least one user-authored feed entry with content ≥ 60 chars
 *   - user hasn't dismissed this specific entry (localStorage)
 *
 * The action opens the new-channel modal with the entry's content
 * pre-filled as kickoff and the current channel's section pre-
 * selected. The modal handles the actual create + assign flow.
 */

import { useEffect, useMemo, useState } from "react";
import type { Channel, ChannelEntry } from "../types";

const MIN_LEN = 60;
const DISMISS_KEY_PREFIX = "relay.spinout.dismissed:";

type Props = {
  channel: Channel;
  feed: ChannelEntry[];
  onSpinout: (kickoff: string) => void;
};

export function SpinoutSuggestion({ channel, feed, onSpinout }: Props) {
  const candidate = useMemo(() => pickCandidate(channel, feed), [channel, feed]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readDismissed());

  useEffect(() => {
    setDismissedIds(readDismissed());
  }, [channel.channelId]);

  if (!candidate) return null;
  if (dismissedIds.has(candidate.entryId)) return null;

  const preview = candidate.content.trim().slice(0, 140).replace(/\s+/g, " ");
  const truncated = candidate.content.length > 140 ? `${preview}…` : preview;

  const dismiss = () => {
    const next = new Set(dismissedIds);
    next.add(candidate.entryId);
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
          onClick={() => onSpinout(candidate.content)}
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

/**
 * Look up the most recent user-authored, substantive feed entry in
 * this channel. Returns null unless the channel qualifies + a
 * candidate exists. Keeps the heuristic contained so tests / future
 * tweaks land in one place.
 */
function pickCandidate(channel: Channel, feed: ChannelEntry[]): ChannelEntry | null {
  const isGeneral = /^general$/i.test(channel.name.trim());
  if (!isGeneral) return null;
  for (let i = feed.length - 1; i >= 0; i--) {
    const e = feed[i];
    if (e.type !== "user_message" && e.type !== "message") continue;
    if (e.content.trim().length < MIN_LEN) continue;
    return e;
  }
  return null;
}

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY_PREFIX + "all");
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissed(set: Set<string>): void {
  try {
    localStorage.setItem(DISMISS_KEY_PREFIX + "all", JSON.stringify([...set]));
  } catch {
    /* storage blocked — best-effort */
  }
}
