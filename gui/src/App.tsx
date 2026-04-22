import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Channel, GuiSettings } from "./types";
import { CenterPane } from "./components/CenterPane";
import { NewChannelModal } from "./components/NewChannelModal";
import { RightPane } from "./components/RightPane";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceRail } from "./components/WorkspaceRail";

const RAIL_OPEN_KEY = "relay.rightRailOpen";

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
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
    api.listChannels(includeArchived).then((cs) => {
      if (cancelled) return;
      setChannels(cs);
      if (!selectedId && cs.length > 0) {
        const firstActive = cs.find((c) => c.status === "active") ?? cs[0];
        setSelectedId(firstActive.channelId);
      }
    });
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
        });
      });
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSessionId(null);
  }, [selectedId]);

  const selected = channels.find((c) => c.channelId === selectedId) ?? null;

  return (
    <div className={`app ${rightRailOpen ? "" : "rail-collapsed"}`}>
      <WorkspaceRail onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen && settings ? (
        <div style={{ gridColumn: "2 / -1", display: "flex", minHeight: 0 }}>
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
            onSelect={setSelectedId}
            onNewChannel={() => setModalOpen(true)}
            onToggleIncludeArchived={setIncludeArchived}
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
            onChannelRemoved={(id) => {
              if (selectedId === id) setSelectedId(null);
              refresh();
            }}
          />
          {rightRailOpen && selected && (
            <RightPane
              channel={selected}
              sessionId={sessionId}
              onSelectSession={setSessionId}
              refreshTick={refreshTick}
              onRefresh={refresh}
            />
          )}
          {!rightRailOpen && <div />}
        </>
      )}
      <NewChannelModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(id) => {
          setSelectedId(id);
          refresh();
        }}
      />
    </div>
  );
}
