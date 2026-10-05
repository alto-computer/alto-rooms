import { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { resolveConnection, type Connection } from "@/lib/connection";

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

  return (
    <main className="flex h-screen items-center justify-center bg-surface text-ink">
      <h1 className="text-[17px] font-medium">Rooms</h1>
    </main>
  );
}
