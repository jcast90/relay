import { useEffect, useState } from "react";
import { api } from "./api";
import type { Channel } from "./types";
import { Sidebar } from "./components/Sidebar";
import { CenterPane } from "./components/CenterPane";
import { RightPane } from "./components/RightPane";
import { NewChannelModal } from "./components/NewChannelModal";

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = () => setRefreshTick((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    api.listChannels().then((cs) => {
      if (cancelled) return;
      setChannels(cs);
      if (!selectedId && cs.length > 0) setSelectedId(cs[0].channelId);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  // Reset session when switching channels
  useEffect(() => {
    setSessionId(null);
  }, [selectedId]);

  const selected = channels.find((c) => c.channelId === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar
        channels={channels}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNewChannel={() => setModalOpen(true)}
      />
      <CenterPane
        channel={selected}
        sessionId={sessionId}
        refreshTick={refreshTick}
        onRefresh={refresh}
        onSessionCreated={setSessionId}
      />
      <RightPane
        channel={selected}
        sessionId={sessionId}
        onSelectSession={setSessionId}
        refreshTick={refreshTick}
      />
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
