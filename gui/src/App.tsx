import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { maybeSeedFirstRun } from "./lib/firstRun";
import { useAppearance } from "./lib/appearance";
import type { Channel, GuiSettings } from "./types";
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
  const [runningStreams, setRunningStreams] = useState<number>(0);
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

  return (
    <div className="app-shell">
      <UpdateBanner />
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
              runningStreams={runningStreams}
              onSelect={(id) => selectChannel(id)}
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
              onStreamingChanged={setRunningStreams}
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
