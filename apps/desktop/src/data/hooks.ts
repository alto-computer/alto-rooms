import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
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

/** The room's artifacts (createdAt ASC); `undefined` while loading. Watches the room on mount. */
export function useArtifacts(roomId: string): Artifact[] | undefined {
  const store = useRoomsStore();
  useEffect(() => {
    void store.loadArtifacts(roomId);
  }, [store, roomId]);
  return useSyncExternalStore(store.subscribe, () => store.getState().artifacts[roomId]);
}

/** The journal day; `undefined` while loading. Watches the day on mount. */
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
