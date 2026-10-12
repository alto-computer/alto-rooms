import { useCallback, useSyncExternalStore } from "react";
import type { RoomsEvent, Session, SessionRef } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { sameSession, sessionKey, toSessionRef } from "@/lib/sessions";
import { useClient, useRoomsStore, type RoomsClient } from "./hooks";
import type { RoomsStore } from "./roomsStore";

/** `undefined` while loading, `null` when roomsd knows no such session, `"error"` when it could not answer. */
export type SessionState = Session | null | "error" | undefined;

function touches(e: RoomsEvent, sessionRef: SessionRef): boolean {
  if (e.type === "session.moved") return sameSession(e.session, sessionRef);
  return e.type === "resync" && e.roomId === null;
}

/** One session's load, shared by everything showing it (its tab label and its view). */
type Load = { state: SessionState; listeners: Set<() => void>; end: () => void };

const loads = new WeakMap<RoomsStore, Map<string, Load>>();

function loadsOf(store: RoomsStore): Map<string, Load> {
  let byKey = loads.get(store);
  if (!byKey) loads.set(store, (byKey = new Map()));
  return byKey;
}

/** The load of `sessionRef`, started for its first watcher; the last one to leave ends it. */
function startLoad(client: RoomsClient, store: RoomsStore, sessionRef: SessionRef): Load {
  const byKey = loadsOf(store);
  const key = sessionKey(sessionRef);
  let latest = 0;
  const set = (state: SessionState) => {
    l.state = state;
    for (const fn of [...l.listeners]) fn();
  };
  const fetch = () => {
    const mine = ++latest;
    client.getSession(sessionRef).then(
      ({ data }) => {
        if (mine === latest) set(data);
      },
      (e: unknown) => {
        const gone = e instanceof RoomsApiError && e.status === 404;
        if (!gone) console.warn("could not load the session", e);
        // Once it has loaded, a failed or 404 refetch keeps what is shown; only a first load says so.
        const shown = typeof l.state === "object" && l.state !== null;
        if (mine === latest && !shown) set(gone ? null : "error");
      },
    );
  };
  const stop = store.onSignal((_type, e) => {
    if (touches(e, sessionRef)) fetch();
  });
  window.addEventListener("focus", fetch);
  const l: Load = {
    state: undefined,
    listeners: new Set(),
    end: () => {
      stop();
      window.removeEventListener("focus", fetch);
      latest = -1;
      byKey.delete(key);
    },
  };
  byKey.set(key, l);
  fetch();
  return l;
}

/**
 * One session with its room. Refetched when it moves (`session.moved`), on a full resync, and
 * when the window gets focus (its log grows without an event). Everything showing the same
 * session shares one load.
 */
export function useSession(sessionRef: SessionRef): SessionState {
  const client = useClient();
  const store = useRoomsStore();
  const key = sessionKey(sessionRef);
  const ref = toSessionRef(sessionRef);
  // The ref object is rebuilt on every render; its key says when it really changed.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const l = loadsOf(store).get(key) ?? startLoad(client, store, ref);
      l.listeners.add(onChange);
      return () => {
        l.listeners.delete(onChange);
        if (l.listeners.size === 0) l.end();
      };
    },
    [client, store, key],
  );
  return useSyncExternalStore(subscribe, () => loadsOf(store).get(key)?.state);
}
