import { useEffect, useState } from "react";
import { api, subscribeChatEvents, type ChatEvent } from "../api";
import type {
  Channel,
  ChannelEntry,
  ChatSession,
  Decision,
  GuiSettings,
  PersistedChatMessage,
  TicketLedgerEntry,
} from "../types";
import { BoardView } from "./BoardView";
import { ChannelHeader, type ChannelTab } from "./ChannelHeader";
import { ChannelSettingsDrawer } from "./ChannelSettingsDrawer";
import { Composer, reduceStream, type ActiveStream } from "./Composer";
import { DecisionsView } from "./DecisionsView";
import { MessageList } from "./MessageList";

type Props = {
  channel: Channel | null;
  sessionId: string | null;
  refreshTick: number;
  rightRailOpen: boolean;
  settings: GuiSettings | null;
  onToggleRail: () => void;
  onRefresh: () => void;
  onSessionCreated: (sessionId: string) => void;
  onChannelRemoved: (id: string) => void;
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
  onChannelRemoved,
}: Props) {
  const [tab, setTab] = useState<ChannelTab>("chat");
  const [feed, setFeed] = useState<ChannelEntry[]>([]);
  const [tickets, setTickets] = useState<TicketLedgerEntry[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [sessionMessages, setSessionMessages] = useState<PersistedChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [stream, setStream] = useState<ActiveStream | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    Promise.all([
      api.listFeed(channel.channelId, 200),
      api.listChannelTickets(channel.channelId),
      api.listChannelDecisions(channel.channelId),
      api.listSessions(channel.channelId),
    ]).then(([f, t, d, s]) => {
      if (cancelled) return;
      setFeed(f);
      setTickets(t);
      setDecisions(d);
      setSessions(s);
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
    api.loadSession(channel.channelId, sessionId, 500).then(setSessionMessages);
  }, [channel?.channelId, sessionId, refreshTick]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    subscribeChatEvents((event: ChatEvent) => {
      setStream((current) => {
        if (!current || event.streamId !== current.streamId) return current;
        return reduceStream(current, event);
      });
      if (event.kind === "done" || event.kind === "error") {
        onRefresh();
        setStream((current) => (current && current.streamId === event.streamId ? null : current));
      }
    }).then((u) => (unlisten = u));
    return () => {
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

  return (
    <div className="center-pane">
      <ChannelHeader
        channel={channel}
        tab={tab}
        onTabChange={setTab}
        rightRailOpen={rightRailOpen}
        onToggleRail={onToggleRail}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={onRefresh}
      />
      {tab === "chat" && (
        <>
          <MessageList
            channel={channel}
            sessionId={sessionId}
            feed={feed}
            sessionMessages={sessionMessages}
            stream={stream}
            streamId={stream?.streamId ?? null}
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
            streaming={!!stream}
            onStartStream={setStream}
            onSessionCreated={onSessionCreated}
          />
        </>
      )}
      {tab === "board" && <BoardView tickets={tickets} settings={settings} />}
      {tab === "decisions" && <DecisionsView decisions={decisions} channel={channel} />}
      {settingsOpen && (
        <ChannelSettingsDrawer
          channel={channel}
          onClose={() => setSettingsOpen(false)}
          onRefresh={onRefresh}
          onArchived={() => onChannelRemoved(channel.channelId)}
        />
      )}
    </div>
  );
}
