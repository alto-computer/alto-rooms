import { useEffect, useState } from "react";
import type { Conversation, RoomsEvent } from "@alto-rooms/protocol-ts";
import { useClient, useRoomsStore } from "./hooks";

function touches(e: RoomsEvent, roomId: string): boolean {
  switch (e.type) {
    case "conversation.moved":
      return e.fromRoomId === roomId || e.conversation.roomId === roomId;
    case "resync":
      return e.roomId === null || e.roomId === roomId;
    default:
      return false;
  }
}

/**
 * The conversations added to a room, last active first; `undefined` until the first answer,
 * `"error"` when that answer was a failure.
 * Refetched when one moves in or out (`conversation.moved`), on a resync, and when the window
 * gets focus (their last replies change in the agents' logs, which send no event).
 */
export function useRoomConversations(roomId: string): Conversation[] | "error" | undefined {
  const client = useClient();
  const store = useRoomsStore();
  const [loaded, setLoaded] = useState<{ roomId: string; list: Conversation[] | "error" } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      client.listRoomConversations(roomId).then(
        ({ data }) => {
          if (live && mine === latest) setLoaded({ roomId, list: data });
        },
        (e: unknown) => {
          console.warn("could not list the room's conversations", e);
          // A failed refetch keeps what is shown; only a first load shows the error.
          if (live && mine === latest) setLoaded((l) => (l?.roomId === roomId && l.list !== "error" ? l : { roomId, list: "error" }));
        },
      );
    };
    load();
    const stop = store.onSignal((_type, e) => {
      if (touches(e, roomId)) load();
    });
    window.addEventListener("focus", load);
    return () => {
      live = false;
      stop();
      window.removeEventListener("focus", load);
    };
  }, [client, store, roomId]);
  return loaded?.roomId === roomId ? loaded.list : undefined;
}
