import { createContext, createElement, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Artifact, JournalDay, createRoomsClient } from "@alto-rooms/protocol-ts";
import type { RoomsState, RoomsStore } from "./roomsStore";
import type { ViewerState, ViewerStore } from "./viewerStore";

/** The roomsd client. Writes (createRoom, renameRoom, linkFolder, saveNote) go through it; state comes back over SSE. */
export type RoomsClient = ReturnType<typeof createRoomsClient>;

type Stores = { rooms: RoomsStore; viewer: ViewerStore; client?: RoomsClient };

const StoresContext = createContext<Stores | null>(null);

export function StoresProvider({ rooms, viewer, client, children }: Stores & { children?: ReactNode }) {
  const value = useMemo(() => ({ rooms, viewer, client }), [rooms, viewer, client]);
  return createElement(StoresContext.Provider, { value }, children);
}

function useStores(): Stores {
  const s = useContext(StoresContext);
  if (!s) throw new Error("StoresProvider is missing");
  return s;
}

export const useRoomsStore = (): RoomsStore => useStores().rooms;
export const useViewerStore = (): ViewerStore => useStores().viewer;

export function useClient(): RoomsClient {
  const { client } = useStores();
  if (!client) throw new Error("StoresProvider has no client");
  return client;
}

export function useRooms(): RoomsState {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/**
 * The room's artifacts (createdAt ASC); `undefined` while loading or after a
 * failed first load (see `useScopeError(\`room:${roomId}\`)`). Watches the room
 * while mounted. The store reloads it by itself if it leaves the room list
 * (`room.removed`, or a resync no longer lists it) and comes back.
 */
export function useArtifacts(roomId: string): Artifact[] | undefined {
  const store = useRoomsStore();
  useEffect(() => {
    void store.loadArtifacts(roomId);
    return () => store.unwatchArtifacts(roomId);
  }, [store, roomId]);
  return useSyncExternalStore(store.subscribe, () => store.getState().artifacts[roomId]);
}

/**
 * Watches the artifacts of every room in `roomIds` while mounted, adding and
 * letting go of rooms as the list changes (rooms that stay are not reloaded).
 */
export function useWatchArtifacts(roomIds: readonly string[]): void {
  const store = useRoomsStore();
  const held = useRef(new Set<string>());
  const key = roomIds.join("\n");
  useEffect(() => {
    const want = new Set(key ? key.split("\n") : []);
    for (const id of want) {
      if (held.current.has(id)) continue;
      held.current.add(id);
      void store.loadArtifacts(id);
    }
    for (const id of [...held.current]) {
      if (want.has(id)) continue;
      held.current.delete(id);
      store.unwatchArtifacts(id);
    }
  }, [store, key]);
  useEffect(() => {
    const h = held.current;
    return () => {
      for (const id of h) store.unwatchArtifacts(id);
      h.clear();
    };
  }, [store]);
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

/** The journal day; `undefined` while loading or after a failed first load (see `useScopeError(\`day:${date}\`)`). Watches the day while mounted. */
export function useJournalDay(date: string): JournalDay | undefined {
  const store = useRoomsStore();
  useEffect(() => {
    void store.loadDay(date);
    return () => store.unwatchDay(date);
  }, [store, date]);
  return useSyncExternalStore(store.subscribe, () => store.getState().days[date]);
}

export function useViewer(): ViewerState {
  const store = useViewerStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
