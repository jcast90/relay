import { useEffect, useState } from "react";
import { api, subscribeChatEvents, type ChatEvent } from "../api";
import type {
  AutonomousSessionSummary,
  Channel,
  ChannelEntry,
  ChatSession,
  Decision,
  GuiSettings,
  PersistedChatMessage,
  TicketLedgerEntry,
} from "../types";
import { AutonomousSessionHeader } from "./AutonomousSessionHeader";
import { BoardView } from "./BoardView";
import { ChannelHeader, type ChannelTab } from "./ChannelHeader";
import { ChannelSettingsDrawer } from "./ChannelSettingsDrawer";
import { Composer, reduceStream, type ActiveStream } from "./Composer";
import { DecisionsView } from "./DecisionsView";
import { DmHeader } from "./DmHeader";
import { MessageList } from "./MessageList";
import { PromoteDmModal } from "./PromoteDmModal";
import { SpinoutSuggestion } from "./SpinoutSuggestion";

type Props = {
  channel: Channel | null;
  sessionId: string | null;
  refreshTick: number;
  rightRailOpen: boolean;
  settings: GuiSettings | null;
  onToggleRail: () => void;
  onRefresh: () => void;
  onSessionCreated: (sessionId: string) => void;
  onStreamingChanged?: (count: number) => void;
  onChannelRemoved: (id: string) => void;
  /**
   * Spin-out bridge: called when the inline suggestion card in a
   * general channel is accepted. Parent opens the new-channel modal
   * with the kickoff + section pre-filled.
   */
  onSpinoutToChannel?: (kickoff: string, sectionId: string | null) => void;
};

export function CenterPane({
  channel,
  sessionId,
  refreshTick,
  rightRailOpen,
  settings,
  onToggleRail,
  onRefresh,
  onSessionCreated,
  onStreamingChanged,
  onChannelRemoved,
  onSpinoutToChannel,
}: Props) {
  const [tab, setTab] = useState<ChannelTab>("chat");
  const [feed, setFeed] = useState<ChannelEntry[]>([]);
  const [tickets, setTickets] = useState<TicketLedgerEntry[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [sessionMessages, setSessionMessages] = useState<PersistedChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [stream, setStream] = useState<ActiveStream | null>(null);

  // Streams are single-slot in CenterPane but tagged with the channel
  // they started in. When the user switches channels, the state persists
  // (so returning to the origin channel still shows the card) but we
  // hide it from the now-foreground channel. Without this scoping, the
  // card — and its "streaming" predicate — leaked across channels.
  const currentStream = stream && channel && stream.channelId === channel.channelId ? stream : null;
  // A closed stream card is kept mounted so the user can review the
  // completed turn's activity + response. It is NOT "in flight" though,
  // so it must not gate the composer's submit button (Composer
  // disables send while `streaming` is true). `isStreaming` is the
  // load-bearing predicate for the *current* channel's composer.
  const isStreaming = !!currentStream && !currentStream.closed;
  // Push streaming presence up to App so the Sidebar's Running row can
  // show a real count. This reports globally (any channel) because the
  // sidebar is channel-agnostic — a background stream should still count.
  const hasLiveStream = !!stream && !stream.closed;
  useEffect(() => {
    onStreamingChanged?.(hasLiveStream ? 1 : 0);
  }, [hasLiveStream, onStreamingChanged]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  // AL-10: resolve "is there an autonomous session for this channel?" by
  // listing every session and filtering on channelId. One small list call
  // per refreshTick; the backend returns only the summary fields needed
  // for the match, not the full session state.
  const [autonomousSessions, setAutonomousSessions] = useState<AutonomousSessionSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listAutonomousSessions()
      .then((sessions) => {
        if (!cancelled) setAutonomousSessions(sessions);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[center] listAutonomousSessions failed", err);
          setAutonomousSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Pick the most recently started non-terminal session for this channel.
  // `listAutonomousSessions` already sorts most-recent-first, so the first
  // non-terminal match is the right one. Terminal (`done` / `killed`)
  // sessions are filtered out — the header only tracks live sessions.
  const activeAutonomousSession = channel
    ? (autonomousSessions.find(
        (s) => s.channelId === channel.channelId && s.state !== "done" && s.state !== "killed"
      ) ?? null)
    : null;

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    Promise.all([
      api.listFeed(channel.channelId, 200),
      api.listChannelTickets(channel.channelId),
      api.listChannelDecisions(channel.channelId),
      api.listSessions(channel.channelId),
    ])
      .then(([f, t, d, s]) => {
        if (cancelled) return;
        setFeed(f);
        setTickets(t);
        setDecisions(d);
        setSessions(s);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[center] batch fetch failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [channel?.channelId, refreshTick]);

  useEffect(() => {
    if (!channel || !sessionId) {
      setSessionMessages([]);
      return;
    }
    let cancelled = false;
    api
      .loadSession(channel.channelId, sessionId, 500)
      .then((ms) => {
        if (!cancelled) setSessionMessages(ms);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[center] loadSession failed", err);
        setSessionMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channel?.channelId, sessionId, refreshTick]);

  // Tauri's `subscribeChatEvents` returns an UnlistenFn asynchronously.
  // If the effect unmounts before the promise resolves, we must still call
  // the unlisten that arrives late — otherwise the channel listener leaks
  // for the rest of the process lifetime.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    subscribeChatEvents((event: ChatEvent) => {
      setStream((current) => {
        if (!current || event.streamId !== current.streamId) return current;
        return reduceStream(current, event);
      });
      if (event.kind === "done" || event.kind === "error") {
        // Previously the card faded out and was torn down on done. The
        // user asked for the activity history to stick around so they
        // can see what the agent actually did — keep the card mounted,
        // auto-expand the activity stack, and mark the turn as closed.
        // The card unmounts on the NEXT user submit (optimistic handler
        // above calls setStream(null)) or on channel switch. We still
        // onRefresh so the persisted assistant message + user message
        // are loaded — SessionMessages dedupes the duplicate assistant
        // content when a closed stream is present.
        const { streamId } = event;
        setStream((current) =>
          current && current.streamId === streamId
            ? { ...current, closed: true, expanded: true }
            : current
        );
        onRefresh();
      }
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [onRefresh]);

  const activeSession = sessions.find((s) => s.sessionId === sessionId) ?? null;

  if (!channel) {
    return (
      <div className="center-pane">
        <div className="center-empty">Select or create a channel</div>
      </div>
    );
  }

  const isDm = channel.kind === "dm";

  return (
    <div className="center-pane">
      {isDm ? (
        <DmHeader
          channel={channel}
          rightRailOpen={rightRailOpen}
          onToggleRail={onToggleRail}
          onPromote={() => setPromoteOpen(true)}
        />
      ) : (
        <>
          <ChannelHeader
            channel={channel}
            tab={tab}
            onTabChange={setTab}
            rightRailOpen={rightRailOpen}
            onToggleRail={onToggleRail}
            onOpenSettings={() => setSettingsOpen(true)}
            onRefresh={onRefresh}
            tabCounts={{ board: tickets.length, decisions: decisions.length }}
          />
          {activeAutonomousSession && (
            // AL-10: autonomous-session strip renders below the header
            // and above the tabs' content so the budget / lifecycle state
            // is visible across every view (chat, board, decisions).
            // DMs don't get this — autonomous sessions don't make sense
            // for kickoff surfaces.
            <AutonomousSessionHeader
              sessionId={activeAutonomousSession.sessionId}
              refreshTick={refreshTick}
              onStopped={onRefresh}
            />
          )}
        </>
      )}
      {(isDm || tab === "chat") && (
        <>
          {!isDm && onSpinoutToChannel && (
            <SpinoutSuggestion
              channel={channel}
              sessionMessages={sessionMessages}
              onSpinout={(kickoff) => onSpinoutToChannel(kickoff, channel.sectionId ?? null)}
            />
          )}
          <MessageList
            channel={channel}
            sessionId={sessionId}
            feed={feed}
            sessionMessages={sessionMessages}
            stream={currentStream}
            streamId={currentStream?.streamId ?? null}
            onToggleStreamExpanded={() =>
              setStream((s) => (s ? { ...s, expanded: !s.expanded } : s))
            }
            onRewound={() => {
              setStream(null);
              onRefresh();
            }}
          />
          <Composer
            channel={channel}
            sessionId={sessionId}
            activeSession={activeSession}
            streaming={isStreaming}
            onStartStream={setStream}
            onSessionCreated={onSessionCreated}
            onSlashNew={isDm ? () => setPromoteOpen(true) : undefined}
            onOptimisticUserMessage={(content, alias) => {
              // The real user message gets persisted server-side and
              // shows up via onRefresh when `done` fires; the optimistic
              // insert just bridges the perceptual gap between click and
              // round-trip. `loadSession` is the authority — its re-
              // render replaces this stub.
              setSessionMessages((prev) => [
                ...prev,
                {
                  role: "user",
                  content,
                  timestamp: new Date().toISOString(),
                  agentAlias: alias ?? undefined,
                },
              ]);
              // Also clear any previously settled stream so the new
              // optimistic turn isn't stacked against a stale card.
              setStream(null);
            }}
          />
        </>
      )}
      {!isDm && tab === "board" && <BoardView tickets={tickets} settings={settings} />}
      {!isDm && tab === "decisions" && <DecisionsView decisions={decisions} channel={channel} />}
      {settingsOpen && !isDm && (
        <ChannelSettingsDrawer
          channel={channel}
          onClose={() => setSettingsOpen(false)}
          onRefresh={onRefresh}
          onArchived={() => onChannelRemoved(channel.channelId)}
        />
      )}
      {promoteOpen && isDm && (
        <PromoteDmModal
          channel={channel}
          onClose={() => setPromoteOpen(false)}
          onPromoted={() => {
            setPromoteOpen(false);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
