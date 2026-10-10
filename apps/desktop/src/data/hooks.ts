import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { AsksStore, type AsksState } from "@/ask/asksStore";
import { PluginsStore, type PluginsState } from "@/plugins/pluginsStore";
import type { Artifact, Info, JournalDay, Room, createRoomsClient } from "@alto-rooms/protocol-ts";
import type { RoomsState, RoomsStore } from "./roomsStore";
import type { ViewerState, ViewerStore } from "./viewerStore";

/** The roomsd client. Writes (createRoom, renameRoom, linkFolder, saveNote) go through it; state comes back over SSE. */
export type RoomsClient = ReturnType<typeof createRoomsClient>;

type Stores = { rooms: RoomsStore; viewer: ViewerStore; client?: RoomsClient };

const StoresContext = createContext<(Stores & { plugins: PluginsStore; asks: AsksStore }) | null>(null);

export function StoresProvider({ rooms, viewer, client, children }: Stores & { children?: ReactNode }) {
  // The plugin list rides the rooms event stream (plugins.changed, resync).
  const plugins = useMemo(() => new PluginsStore(client, rooms, __APP_VERSION__), [client, rooms]);
  useEffect(() => {
    plugins.start();
    return () => plugins.stop();
  }, [plugins]);
  const asks = useMemo(() => new AsksStore(client, rooms), [client, rooms]);
  useEffect(() => {
    asks.start();
    return () => asks.stop();
  }, [asks]);
  const value = useMemo(() => ({ rooms, viewer, client, plugins, asks }), [rooms, viewer, client, plugins, asks]);
  return createElement(StoresContext.Provider, { value }, children);
}

function useStores(): Stores & { plugins: PluginsStore; asks: AsksStore } {
  const s = useContext(StoresContext);
  if (!s) throw new Error("StoresProvider is missing");
  return s;
}

export const useRoomsStore = (): RoomsStore => useStores().rooms;
export const useViewerStore = (): ViewerStore => useStores().viewer;
export const usePluginsStore = (): PluginsStore => useStores().plugins;

export const useAsksStore = (): AsksStore => useStores().asks;

/** Whether the ask bar is open, and ask threads by file key. */
export function useAsks(): AsksState {
  const store = useAsksStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** The plugin list (with app compatibility) and this run's dismissed enable cards. */
export function usePlugins(): PluginsState {
  const store = usePluginsStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function useClient(): RoomsClient {
  const { client } = useStores();
  if (!client) throw new Error("StoresProvider has no client");
  return client;
}

/**
 * The whole rooms state: re-renders on every change, including artifact and day
 * loads anywhere. Prefer the slices below (`useRoomList`, `useInfo`), which only
 * re-render when their own part changes.
 */
export function useRooms(): RoomsState {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** The room list (listRooms order). */
export function useRoomList(): Room[] {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, () => store.getState().rooms);
}

/** The core's info; `null` before the first sync. */
export function useInfo(): Info | null {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, () => store.getState().info);
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

/** `useJournalDay` for several days at once, in the order given. */
export function useJournalDays(dates: readonly string[]): (JournalDay | undefined)[] {
  const store = useRoomsStore();
  const key = dates.join(",");
  useEffect(() => {
    const list = key.split(",");
    for (const d of list) void store.loadDay(d);
    return () => list.forEach((d) => store.unwatchDay(d));
  }, [store, key]);
  const days = useSyncExternalStore(store.subscribe, () => store.getState().days);
  return dates.map((d) => days[d]);
}

/**
 * True while nothing may be written: the core is read-only, or its info has
 * not arrived yet (before the first sync we can't tell). Every write
 * affordance (new room, room rename, new note, the note body) follows it.
 */
export function useReadOnly(): boolean {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, () => {
    const info = store.getState().info;
    return info === null || info.readOnly;
  });
}

export function useViewer(): ViewerState {
  const store = useViewerStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Opens a doc in this tab, or in a new one when `newTab` (see `wantsNewTab`). */
export function useOpenDoc(): (a: Artifact, newTab: boolean) => void {
  const viewer = useViewerStore();
  return useCallback((a: Artifact, newTab: boolean) => viewer.go({ kind: "doc", roomId: a.roomId, artifactId: a.id }, newTab), [viewer]);
}
