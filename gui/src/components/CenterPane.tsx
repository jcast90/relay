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
import { PromoteDmModal } from "./PromoteDmModal";

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
}: Props) {
  const [tab, setTab] = useState<ChannelTab>("chat");
  const [feed, setFeed] = useState<ChannelEntry[]>([]);
  const [tickets, setTickets] = useState<TicketLedgerEntry[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [sessionMessages, setSessionMessages] = useState<PersistedChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [stream, setStream] = useState<ActiveStream | null>(null);

  // Push streaming presence up to App so the Sidebar's Running row can
  // show a real count. Single-center-pane app → count is 0 or 1.
  useEffect(() => {
    onStreamingChanged?.(stream ? 1 : 0);
  }, [stream, onStreamingChanged]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);

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
        onRefresh();
        setStream((current) => (current && current.streamId === event.streamId ? null : current));
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
      <ChannelHeader
        channel={channel}
        tab={isDm ? "chat" : tab}
        onTabChange={setTab}
        rightRailOpen={rightRailOpen}
        onToggleRail={onToggleRail}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={onRefresh}
        hideTabs={isDm}
      />
      {isDm && (
        <DmBanner
          channel={channel}
          onPromoted={(newChannelId) => {
            onRefresh();
            // Promote keeps the same channelId (we just flip kind); no
            // redirect needed, but the sidebar will move it to Channels.
            void newChannelId;
          }}
        />
      )}
      {(isDm || tab === "chat") && (
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
            onSlashNew={isDm ? () => setPromoteOpen(true) : undefined}
          />
        </>
      )}
      {!isDm && tab === "board" && <BoardView tickets={tickets} settings={settings} />}
      {!isDm && tab === "decisions" && (
        <DecisionsView decisions={decisions} channel={channel} />
      )}
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

function DmBanner({
  channel,
  onPromoted,
}: {
  channel: import("../types").Channel;
  onPromoted: (channelId: string) => void;
}) {
  const [promoteOpen, setPromoteOpen] = useState(false);
  return (
    <>
      <div
        style={{
          padding: "var(--space-4) var(--space-8)",
          background: "rgba(232, 154, 43, 0.12)",
          borderBottom: "1px solid var(--color-paper-line)",
          fontSize: "var(--font-size-base)",
          color: "var(--color-text-muted)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-5)",
        }}
      >
        <span style={{ flex: 1 }}>
          <strong style={{ color: "var(--color-text-primary)" }}>Kickoff surface.</strong>{" "}
          You're 1:1 with this agent. Promote to a full channel when the work is real — try{" "}
          <code
            style={{
              padding: "1px 6px",
              background: "var(--color-paper-alt)",
              borderRadius: 3,
              fontFamily: "var(--font-mono)",
            }}
          >
            /new
          </code>{" "}
          in the composer.
        </span>
        <button className="primary" onClick={() => setPromoteOpen(true)}>
          Promote to channel →
        </button>
      </div>
      {promoteOpen && (
        <PromoteDmModal
          channel={channel}
          onClose={() => setPromoteOpen(false)}
          onPromoted={onPromoted}
        />
      )}
    </>
  );
}
