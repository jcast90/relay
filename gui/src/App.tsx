import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { maybeSeedFirstRun } from "./lib/firstRun";
import { useAppearance } from "./lib/appearance";
import { tokenPctSeverity } from "./lib/tokenSeverity";
import type { Channel, ChatSessionBudget, GuiSettings } from "./types";
import { CenterPane } from "./components/CenterPane";
import { NewChannelModal } from "./components/NewChannelModal";
import { NewDmModal } from "./components/NewDmModal";
import { RightPane } from "./components/RightPane";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { UpdateBanner } from "./components/UpdateBanner";

const RAIL_OPEN_KEY = "relay.rightRailOpen";

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [newChannelSection, setNewChannelSection] = useState<string | null>(null);
  const [newChannelKickoff, setNewChannelKickoff] = useState<string>("");
  const [dmModalOpen, setDmModalOpen] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_OPEN_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  // Tracks the channel currently streaming, if any. The previous shape
  // was just a count (0/1) — useful for the Sidebar pulse but the
  // Running tab onClick had nowhere to navigate. Holding the channelId
  // lets the click jump back to the streaming channel from anywhere.
  const [runningChannelId, setRunningChannelId] = useState<string | null>(null);
  const [appearance] = useAppearance();

  // Stable identity so effects that depend on it (CenterPane's chat-event
  // subscription) don't tear down on every parent render — we also run a
  // 5s setInterval that bumps refreshTick, which would otherwise churn
  // listeners once per tick.
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_OPEN_KEY, rightRailOpen ? "true" : "false");
    } catch {
      /* storage blocked — best-effort */
    }
  }, [rightRailOpen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // On the first-ever boot (no sections + no channels), drop a
      // Workspace section + #general welcome channel so the user lands
      // on content instead of a blank sidebar. Noop on every boot after.
      if (refreshTick === 0) {
        const seeded = await maybeSeedFirstRun();
        if (seeded) setRefreshTick((n) => n + 1);
      }
      const cs = await api.listChannels(includeArchived);
      if (cancelled) return;
      setChannels(cs);
      if (!selectedId && cs.length > 0) {
        const firstActive = cs.find((c) => c.status === "active") ?? cs[0];
        selectChannel(firstActive.channelId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, includeArchived]);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch(() => {
        setSettings({
          ticketProvider: "relay",
          linearApiToken: "",
          linearWorkspace: "",
          linearPollSeconds: 30,
          rightRailOpen: true,
          agentBinaries: {},
        });
      });
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Session counts power the Sidebar Threads row. Polled on the same
    // refresh cadence as channels; silently empty on failure.
    api
      .listSessionCounts()
      .then(setSessionCounts)
      .catch(() => setSessionCounts({}));
  }, [refreshTick]);

  // Phase 1 PR-3 / Task 7 — worst-session chip.
  //
  // Polls `list_chat_session_budgets` (Tauri backend filters
  // `kind === "chat"` so admin/run sessions are already excluded) and
  // surfaces the highest-pct chat session as a chip beside the update
  // banner whenever it crosses 75%. The chip is purely informational —
  // clicking it would require mapping sid → channelId, which we don't
  // currently expose; surfacing it is enough to drive the user back to
  // the relevant channel via the Sidebar.
  const [chatBudgets, setChatBudgets] = useState<ChatSessionBudget[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listChatSessionBudgets()
      .then((bs) => {
        if (!cancelled) setChatBudgets(bs);
      })
      .catch(() => {
        if (!cancelled) setChatBudgets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);
  const worstChatBudget = chatBudgets.reduce<ChatSessionBudget | null>((worst, current) => {
    if (current.used <= 0) return worst;
    if (!worst || current.pct > worst.pct) return current;
    return worst;
  }, null);
  const worstChipVisible = !!worstChatBudget && worstChatBudget.pct >= 75;

  // Atomic setter for the active channel + session pair. The kickoff
  // path sets both at once; manual channel switches default `sessionId`
  // back to null so CenterPane loads the right channel history. Doing
  // this in a single helper (rather than `setSelectedId` + a
  // selectedId-change effect) avoids the same-id no-op leak — if a
  // future caller passes the currently-selected channelId, React's
  // bail-out optimisation would skip the effect and a previously
  // stashed session id would never get cleared.
  const selectChannel = useCallback(
    (channelId: string | null, nextSessionId: string | null = null) => {
      setSelectedId(channelId);
      setSessionId(nextSessionId);
    },
    []
  );

  const selected = channels.find((c) => c.channelId === selectedId) ?? null;

  const onClickWorstChip = useCallback(async () => {
    if (!worstChatBudget) return;
    // Best-effort sid → channel resolver: scan channels' sessions
    // until we find the one whose `claudeSessionIds` map contains our
    // sid. Bounded by O(channels), each call is one Tauri round-trip.
    // Silent failures land back on a no-op so the chip never crashes
    // the app shell.
    for (const ch of channels) {
      try {
        const sessions = await api.listSessions(ch.channelId);
        const match = sessions.find((s) =>
          Object.values(s.claudeSessionIds).includes(worstChatBudget.sessionId)
        );
        if (match) {
          selectChannel(ch.channelId, match.sessionId);
          return;
        }
      } catch {
        /* swallow — try the next channel */
      }
    }
  }, [worstChatBudget, channels]);

  return (
    <div className="app-shell">
      <UpdateBanner />
      {worstChipVisible && worstChatBudget && (
        <button
          type="button"
          className={`worst-session-chip metric--tokens-${tokenPctSeverity(worstChatBudget.pct)}`}
          onClick={onClickWorstChip}
          title={`Jump to chat session ${worstChatBudget.sessionId}`}
        >
          ctx {worstChatBudget.pct.toFixed(0)}% — {worstChatBudget.sessionId.slice(0, 12)}
        </button>
      )}
      <div className={`app density-${appearance.density} ${rightRailOpen ? "" : "rail-collapsed"}`}>
        {settingsOpen && settings ? (
          <div style={{ gridColumn: "1 / -1", display: "flex", minHeight: 0 }}>
            <SettingsPage
              settings={settings}
              onSaved={setSettings}
              onClose={() => setSettingsOpen(false)}
            />
          </div>
        ) : (
          <>
            <Sidebar
              channels={channels}
              selectedId={selectedId}
              includeArchived={includeArchived}
              sessionCounts={sessionCounts}
              runningChannelId={runningChannelId}
              onSelect={(id) => selectChannel(id)}
              onJumpToRunning={() => {
                if (runningChannelId) selectChannel(runningChannelId);
              }}
              onNewChannel={(sectionId) => {
                setNewChannelSection(sectionId ?? null);
                setModalOpen(true);
              }}
              onNewDm={() => setDmModalOpen(true)}
              onToggleIncludeArchived={setIncludeArchived}
              onOpenSettings={() => setSettingsOpen(true)}
              onRefresh={refresh}
            />
            <CenterPane
              channel={selected}
              sessionId={sessionId}
              refreshTick={refreshTick}
              rightRailOpen={rightRailOpen}
              settings={settings}
              onToggleRail={() => setRightRailOpen((v) => !v)}
              onRefresh={refresh}
              onSessionCreated={setSessionId}
              onStreamingChanged={(streaming) => {
                // Hold the streaming channel id, not just a count, so
                // the Running tab can jump back to it from anywhere.
                setRunningChannelId(streaming && selected ? selected.channelId : null);
              }}
              onChannelRemoved={(id) => {
                if (selectedId === id) selectChannel(null);
                refresh();
              }}
              onSpinoutToChannel={(kickoff, sectionId) => {
                setNewChannelKickoff(kickoff);
                setNewChannelSection(sectionId ?? null);
                setModalOpen(true);
              }}
            />
            {rightRailOpen && selected && (
              <RightPane
                channel={selected}
                sessionId={sessionId}
                onSelectSession={setSessionId}
                refreshTick={refreshTick}
                onRefresh={refresh}
                onClose={() => setRightRailOpen(false)}
              />
            )}
            {!rightRailOpen && <div />}
          </>
        )}
        <NewChannelModal
          open={modalOpen}
          defaultSectionId={newChannelSection}
          defaultFirstMessage={newChannelKickoff}
          onClose={() => {
            setModalOpen(false);
            setNewChannelKickoff("");
          }}
          onCreated={(id, kickoffSessionId) => {
            // Set channel + kickoff session atomically so CenterPane's
            // stream subscription sees the right sessionId on first
            // render and Composer doesn't fall through to its
            // `if (!sessionId) createSession` branch on the user's reply.
            selectChannel(id, kickoffSessionId);
            setNewChannelKickoff("");
            refresh();
          }}
        />
        <NewDmModal
          open={dmModalOpen}
          onClose={() => setDmModalOpen(false)}
          onCreated={(id) => {
            selectChannel(id);
            refresh();
          }}
        />
      </div>
    </div>
  );
}
