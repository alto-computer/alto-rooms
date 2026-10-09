import { useEffect, useState } from "react";
import type { Conversation, ConversationId, RoomsEvent } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { conversationKey, sameConversation } from "@/lib/conversations";
import { useClient, useRoomsStore } from "./hooks";

/** `undefined` while loading, `null` when roomsd knows no such conversation, `"error"` when it could not answer. */
export type ConversationState = Conversation | null | "error" | undefined;

function touches(e: RoomsEvent, id: ConversationId): boolean {
  if (e.type === "conversation.moved") return sameConversation(e.conversation.id, id);
  return e.type === "resync" && e.roomId === null;
}

/**
 * One conversation with its room. Refetched when it moves (`conversation.moved`), on a full
 * resync, and when the window gets focus (its log grows without an event).
 */
export function useConversation(id: ConversationId): ConversationState {
  const client = useClient();
  const store = useRoomsStore();
  const key = conversationKey(id);
  const [loaded, setLoaded] = useState<{ key: string; state: ConversationState } | undefined>(undefined);
  useEffect(() => {
    const target = { agent: id.agent, session: id.session };
    let live = true;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      client.getConversation(target).then(
        ({ data }) => {
          if (live && mine === latest) setLoaded({ key, state: data });
        },
        (e: unknown) => {
          const gone = e instanceof RoomsApiError && e.status === 404;
          if (!gone) console.warn("could not load the conversation", e);
          // A failed refetch keeps what is shown; only a first load shows the error.
          if (live && mine === latest) setLoaded((l) => (l?.key === key && l.state && !gone ? l : { key, state: gone ? null : "error" }));
        },
      );
    };
    load();
    const stop = store.onSignal((_type, e) => {
      if (touches(e, target)) load();
    });
    window.addEventListener("focus", load);
    return () => {
      live = false;
      stop();
      window.removeEventListener("focus", load);
    };
    // The id object is rebuilt on every render; its key says when it really changed.
  }, [client, store, key]);
  return loaded?.key === key ? loaded.state : undefined;
}
