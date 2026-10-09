import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle } from "lucide-react";
import { createRoomsClient } from "@alto-rooms/protocol-ts";
import { applyAppearance } from "@/lib/appearance";
import { DAEMON_EXITED, installQuitFlushResponder, listenAll, onBeforeQuitFlush, onQuitFlushAsync } from "@/lib/appEvents";
import { flushAllPlugins } from "@/plugins/host";
import { CLOSE_CAP_MS as PLUGIN_CLOSE_CAP_MS } from "@/plugins/PluginFrame";
import { resolveConnection, type Connection } from "@/lib/connection";
import { runFlushProbe } from "@/lib/flushProbe";
import { rebindNoteSavers } from "@/lib/noteSaverRegistry";
import { isTauri } from "@/lib/tauri";
import { StoresProvider, type RoomsClient } from "@/data/hooks";
import { RoomsStore } from "@/data/roomsStore";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";

/** Consecutive failed syncs (the first failure plus 2 retries) after which the core counts as lost. */
export const LOST_AFTER_SYNC_FAILURES = 3;

type Phase = "pending" | "error" | "ready";
type Stores = { client: RoomsClient; rooms: RoomsStore };

/** Two connections are the same daemon session when both the URL and the token match. */
const sameConnection = (a: Connection, b: Connection) => a.baseUrl === b.baseUrl && a.token === b.token;

/**
 * Connects to roomsd and keeps the stores for that connection.
 *
 * The core counts as lost when the daemon we spawned exits (`daemon://exited`)
 * or when the rooms store stays in error through 2 retries. Then the full-panel
 * error shows; "Try again" runs `connect` again (Rust respawns the daemon). A
 * new connection (URL or token changed) gets a new client and stores, and live
 * note savers are rebound to it so unsaved notes still land.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>("pending");
  const [stores, setStores] = useState<Stores | null>(null);
  // Viewer state is local (tabs, last visits): it survives reconnects.
  const [viewer] = useState(() => new ViewerStore());
  const current = useRef<{ connection: Connection; stores: Stores } | null>(null);
  const attempt = useRef(0);
  const probed = useRef(false);

  const connect = useCallback(() => {
    const mine = ++attempt.current;
    setPhase("pending");
    resolveConnection().then(
      (connection) => {
        if (mine !== attempt.current) return;
        const prev = current.current;
        prev?.stores.rooms.stop();
        // Every (re)connect gets a fresh store (no leftover error state); the
        // client is kept for the same connection and rebuilt for a new one.
        let client: RoomsClient;
        if (prev && sameConnection(prev.connection, connection)) {
          client = prev.stores.client;
        } else {
          const c = createRoomsClient(connection.baseUrl, connection.token);
          client = c;
          rebindNoteSavers((date, name, text) => c.saveNote(date, name, text));
        }
        const cur = { connection, stores: { client, rooms: new RoomsStore(client) } };
        current.current = cur;
        cur.stores.rooms.start();
        setStores(cur.stores);
        setPhase("ready");
        if (__FLUSH_PROBE__ && isTauri() && !probed.current) {
          probed.current = true;
          const { client } = cur.stores;
          runFlushProbe(client.getNote, client.saveNote).catch((err) => console.error("flush probe failed:", err));
        }
      },
      (err) => {
        if (mine !== attempt.current) return;
        console.error("connect failed:", err);
        setPhase("error");
      },
    );
  }, []);

  useEffect(() => {
    connect();
  }, [connect]);

  // Before paint, on every screen (the connecting and error screens too).
  const appearance = useSyncExternalStore(viewer.subscribe, () => viewer.getState().appearance);
  useLayoutEffect(() => applyAppearance(appearance), [appearance]);

  useEffect(
    () => () => {
      current.current?.stores.rooms.stop();
    },
    [],
  );

  // Answer the native close/quit hook on every screen, so closing never waits for its timeout.
  useEffect(() => (isTauri() ? installQuitFlushResponder() : undefined), []);
  // Open plugins save before quitting, inside the same window as the notes.
  useEffect(() => onQuitFlushAsync(() => flushAllPlugins(PLUGIN_CLOSE_CAP_MS)), []);

  // Quitting counts as leaving the active room tab (for "new" dots next time).
  useEffect(() => {
    const flush = () => viewer.flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    const offQuit = onBeforeQuitFlush(flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      offQuit();
    };
  }, [viewer]);

  // Losing the core while connected.
  useEffect(() => {
    if (phase !== "ready" || !stores) return;
    let lost = false;
    const lose = () => {
      if (lost) return;
      lost = true;
      stores.rooms.stop();
      setPhase("error");
    };
    const check = () => {
      const s = stores.rooms.getState();
      if (s.status === "error" && s.syncFailures >= LOST_AFTER_SYNC_FAILURES) lose();
    };
    const unsubscribe = stores.rooms.subscribe(check);
    check();
    const unlisten = isTauri() ? listenAll({ [DAEMON_EXITED]: lose }) : () => {};
    return () => {
      unsubscribe();
      unlisten();
    };
  }, [phase, stores]);

  if (phase === "error") {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-4 bg-desk text-ink">
        <div className="flex items-center gap-2 text-error">
          <AlertCircle size={20} aria-hidden />
          <p className="text-heading font-medium">Couldn't connect to Rooms</p>
        </div>
        <button
          type="button"
          onClick={connect}
          className="rounded-lg bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-thread-deeper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Try again
        </button>
      </main>
    );
  }

  if (phase === "pending" || !stores) {
    return <main className="h-screen bg-desk" aria-busy="true" />;
  }

  return (
    <StoresProvider rooms={stores.rooms} viewer={viewer} client={stores.client}>
      <AppShell />
    </StoresProvider>
  );
}
