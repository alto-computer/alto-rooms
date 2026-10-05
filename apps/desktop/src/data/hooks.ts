import { createContext, createElement, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Artifact, JournalDay } from "@alto-rooms/protocol-ts";
import type { RoomsState, RoomsStore } from "./roomsStore";
import type { ViewerState, ViewerStore } from "./viewerStore";

type Stores = { rooms: RoomsStore; viewer: ViewerStore };

const StoresContext = createContext<Stores | null>(null);

export function StoresProvider({ rooms, viewer, children }: Stores & { children?: ReactNode }) {
  return createElement(StoresContext.Provider, { value: { rooms, viewer } }, children);
}

function useStores(): Stores {
  const s = useContext(StoresContext);
  if (!s) throw new Error("StoresProvider is missing");
  return s;
}

export const useRoomsStore = (): RoomsStore => useStores().rooms;
export const useViewerStore = (): ViewerStore => useStores().viewer;

export function useRooms(): RoomsState {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/**
 * The room's artifacts (createdAt ASC); `undefined` while loading or after a
 * failed first load (see `useScopeError(\`room:${roomId}\`)`). Watches the room
 * on mount, and again whenever the room (re)appears in the room list: the store
 * forgets a room on `room.removed` or when a resync no longer lists it.
 */
export function useArtifacts(roomId: string): Artifact[] | undefined {
  const store = useRoomsStore();
  const listed = useSyncExternalStore(store.subscribe, () => store.getState().rooms.some((r) => r.id === roomId));
  const mounted = useRef(false);
  useEffect(() => {
    // Load on mount (the journal room is never listed) and on reappearance;
    // never re-watch a room just because it disappeared.
    if (listed || !mounted.current) void store.loadArtifacts(roomId);
    mounted.current = true;
  }, [store, roomId, listed]);
  return useSyncExternalStore(store.subscribe, () => store.getState().artifacts[roomId]);
}

/**
 * Error contract for Task 4+: a scope whose fetch failed has a message under
 * `RoomsState.errors`, keyed `room:<roomId>` or `day:<date>`. It is cleared when
 * a later fetch of that scope succeeds; failed scopes are retried on every full
 * resync. Data from an earlier successful load is kept while the error is set,
 * so show the error when data is `undefined` (first load failed), and treat it
 * as "possibly stale" otherwise. The global `status` only reflects info/listRooms.
 */
export function useScopeError(scope: `room:${string}` | `day:${string}`): string | undefined {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, () => store.getState().errors[scope]);
}

/** The journal day; `undefined` while loading or after a failed first load (see `useScopeError(\`day:${date}\`)`). Watches the day on mount. */
export function useJournalDay(date: string): JournalDay | undefined {
  const store = useRoomsStore();
  useEffect(() => {
    void store.loadDay(date);
  }, [store, date]);
  return useSyncExternalStore(store.subscribe, () => store.getState().days[date]);
}

export function useViewer(): ViewerState {
  const store = useViewerStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
