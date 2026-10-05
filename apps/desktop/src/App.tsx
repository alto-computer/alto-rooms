import { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { createRoomsClient } from "@alto-rooms/protocol-ts";
import { resolveConnection, type Connection } from "@/lib/connection";
import { StoresProvider } from "@/data/hooks";
import { RoomsStore } from "@/data/roomsStore";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";

type State =
  | { status: "pending" }
  | { status: "error" }
  | { status: "ready"; connection: Connection };

export default function App() {
  const [state, setState] = useState<State>({ status: "pending" });

  const connect = useCallback(() => {
    setState({ status: "pending" });
    resolveConnection().then(
      (connection) => setState({ status: "ready", connection }),
      (err) => {
        console.error("connect failed:", err);
        setState({ status: "error" });
      },
    );
  }, []);

  useEffect(() => {
    connect();
  }, [connect]);

  if (state.status === "pending") {
    return <main className="h-screen bg-surface" aria-busy="true" />;
  }

  if (state.status === "error") {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-4 bg-surface text-ink">
        <div className="flex items-center gap-2 text-[#c13515]">
          <AlertCircle size={20} aria-hidden />
          <p className="text-[17px] font-medium">Rooms 코어를 시작하지 못했어요</p>
        </div>
        <button
          type="button"
          onClick={connect}
          className="rounded-lg bg-[#ff385c] px-4 py-2 text-[14px] font-medium text-white focus-visible:outline-2 focus-visible:outline-ink"
        >
          다시 시도
        </button>
      </main>
    );
  }

  return <Connected key={state.connection.baseUrl} connection={state.connection} />;
}

function Connected({ connection }: { connection: Connection }) {
  const [stores] = useState(() => {
    const client = createRoomsClient(connection.baseUrl, connection.token);
    return { client, rooms: new RoomsStore(client), viewer: new ViewerStore() };
  });

  useEffect(() => {
    stores.rooms.start();
    return () => stores.rooms.stop();
  }, [stores]);

  // Quitting counts as leaving the active room tab (for "new" dots next time).
  useEffect(() => {
    const flush = () => stores.viewer.flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [stores]);

  return (
    <StoresProvider rooms={stores.rooms} viewer={stores.viewer} client={stores.client}>
      <AppShell />
    </StoresProvider>
  );
}
