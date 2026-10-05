import type { Artifact, Info, JournalDay, Room, RoomsEvent, Snapshot } from "@alto-rooms/protocol-ts";

export type RoomsClientLike = {
  info(): Promise<Info>;
  listRooms(): Promise<Snapshot<Room[]>>;
  listArtifacts(roomId: string): Promise<Snapshot<Artifact[]>>;
  journalDay(date: string): Promise<Snapshot<JournalDay>>;
  subscribe(onEvent: (e: RoomsEvent) => void, onOpen?: () => void): () => void;
};

export type RoomsState = {
  status: "connecting" | "live" | "error";
  info: Info | null;
  rooms: Room[]; // listRooms order
  artifacts: Record<string, Artifact[] | undefined>; // roomId -> createdAt ASC; undefined = not loaded
  days: Record<string, JournalDay | undefined>; // date -> day; undefined = not loaded
  /** Last fetch failure per scope, keyed `room:<id>` / `day:<date>`; cleared on success. */
  errors: Record<string, string | undefined>;
};

export type RoomsStoreOptions = {
  /** Non-fatal problems (one scope failed to refetch). Defaults to console.warn. */
  warn?: (...args: unknown[]) => void;
};

const DAY_DEBOUNCE_MS = 150;
/** If the server's leading `resync {null}` doesn't arrive within this, sync anyway. */
const RESYNC_FALLBACK_MS = 2000;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s, 8s, then capped
const BACKOFF_MAX_MS = 10_000;

const instant = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const roomKey = (id: string) => `room:${id}`;
const dayKey = (date: string) => `day:${date}`;

/** createdAt ASC (compared as instants, offsets vary), then id. */
function sortArtifacts(list: Artifact[]): Artifact[] {
  return [...list].sort((a, b) => instant(a.createdAt) - instant(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type RoomFetch = { token: number; queue: RoomsEvent[]; promise: Promise<void> };

/**
 * Client-side mirror of roomsd, kept consistent with the snapshot + seq rule:
 * events are buffered while snapshots are in flight, then replayed per scope,
 * dropping any event whose seq is <= that scope's snapshot seq.
 *
 * Scopes: rooms (one), artifacts (one per watched room), days (refetch-only).
 *
 * Artifact and day scopes are ref-counted: every `loadArtifacts` / `loadDay`
 * is paired with an `unwatchArtifacts` / `unwatchDay`. When the last watcher
 * lets go, the scope's data is dropped and it is no longer refetched. A watched
 * room that disappears from the room list goes dormant (data dropped, not
 * fetched) and reloads by itself when it comes back.
 */
export class RoomsStore {
  private state: RoomsState = { status: "connecting", info: null, rooms: [], artifacts: {}, days: {}, errors: {} };
  private listeners = new Set<() => void>();
  private batchDepth = 0;
  private dirty = false;
  private readonly warn: (...args: unknown[]) => void;

  private started = false;
  private unsubscribe: (() => void) | null = null;

  // Global sync.
  private syncGen = 0;
  private buffering = false;
  private queue: RoomsEvent[] = [];
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Rooms scope.
  private roomsSeq = 0;

  // Artifact scopes: watchers per room, and watched rooms currently absent from the list.
  private roomRefs = new Map<string, number>();
  private dormantRooms = new Set<string>();
  private artifactsSeq = new Map<string, number>();
  private roomTokens = new Map<string, number>();
  private roomFetches = new Map<string, RoomFetch>();

  // Days (refetch-only): watchers per date.
  private dayRefs = new Map<string, number>();
  private dayTokens = new Map<string, number>();
  private dayFetches = new Map<string, Promise<void>>();
  private dayTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly client: RoomsClientLike,
    opts: RoomsStoreOptions = {},
  ) {
    this.warn = opts.warn ?? ((...args) => console.warn(...args));
  }

  // ---------------------------------------------------------------- public

  getState = (): RoomsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Subscribe and buffer. The full sync runs on the server's leading
   * `resync {null}`, or after RESYNC_FALLBACK_MS if it never arrives.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.client.subscribe(this.onEvent, this.onOpen);
    this.enterBuffering();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.syncGen++; // invalidates in-flight sync results
    this.buffering = false;
    this.queue = [];
    this.clearRetry();
    this.clearFallback();
    for (const t of this.dayTimers.values()) clearTimeout(t);
    this.dayTimers.clear();
    for (const roomId of this.roomFetches.keys()) this.bump(this.roomTokens, roomId);
    this.roomFetches.clear();
    for (const date of this.dayFetches.keys()) this.bump(this.dayTokens, date);
    this.dayFetches.clear();
  }

  /**
   * Adds a watcher to the room (refetched on every resync while watched) and
   * loads it once. Pair every call with `unwatchArtifacts(roomId)`.
   */
  loadArtifacts(roomId: string): Promise<void> {
    this.roomRefs.set(roomId, (this.roomRefs.get(roomId) ?? 0) + 1);
    if (this.dormantRooms.has(roomId)) return Promise.resolve();
    const inflight = this.roomFetches.get(roomId);
    if (inflight) return inflight.promise;
    if (this.state.artifacts[roomId] !== undefined) return Promise.resolve();
    return this.fetchRoom(roomId);
  }

  /** Removes a watcher; the last one out drops the room's artifacts and stops refetching them. */
  unwatchArtifacts(roomId: string): void {
    const n = (this.roomRefs.get(roomId) ?? 0) - 1;
    if (n > 0) {
      this.roomRefs.set(roomId, n);
      return;
    }
    this.roomRefs.delete(roomId);
    this.dormantRooms.delete(roomId);
    this.batch(() => this.dropRoom(roomId));
  }

  /**
   * Adds a watcher to the day (refetched on resync and journal/note events)
   * and loads it once. Pair every call with `unwatchDay(date)`.
   */
  loadDay(date: string): Promise<void> {
    this.dayRefs.set(date, (this.dayRefs.get(date) ?? 0) + 1);
    const inflight = this.dayFetches.get(date);
    if (inflight) return inflight;
    if (this.state.days[date] !== undefined) return Promise.resolve();
    return this.fetchDay(date);
  }

  /** Removes a watcher; the last one out drops the day and stops refetching it. */
  unwatchDay(date: string): void {
    const n = (this.dayRefs.get(date) ?? 0) - 1;
    if (n > 0) {
      this.dayRefs.set(date, n);
      return;
    }
    this.dayRefs.delete(date);
    const timer = this.dayTimers.get(date);
    if (timer) clearTimeout(timer);
    this.dayTimers.delete(date);
    this.bump(this.dayTokens, date);
    this.dayFetches.delete(date);
    this.batch(() => {
      if (date in this.state.days) {
        const { [date]: _gone, ...days } = this.state.days;
        this.patch({ days });
      }
      this.setError(dayKey(date), undefined);
    });
  }

  /** Watched and present in the room list (or not yet known to be absent). */
  private isWatchedRoom(roomId: string): boolean {
    return (this.roomRefs.get(roomId) ?? 0) > 0 && !this.dormantRooms.has(roomId);
  }

  private isWatchedDay(date: string): boolean {
    return (this.dayRefs.get(date) ?? 0) > 0;
  }

  // ---------------------------------------------------------------- state

  private setState(next: RoomsState) {
    if (next === this.state) return;
    this.state = next;
    if (this.batchDepth > 0) this.dirty = true;
    else this.notify();
  }

  private notify() {
    for (const l of [...this.listeners]) l();
  }

  /** Runs `fn` and notifies listeners at most once, after it returns. */
  private batch(fn: () => void) {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.dirty) {
        this.dirty = false;
        this.notify();
      }
    }
  }

  private setError(key: string, err: string | undefined) {
    const errors = this.state.errors;
    if (errors[key] === err && (err !== undefined || !(key in errors))) return;
    if (err === undefined) {
      const { [key]: _cleared, ...rest } = errors;
      this.patch({ errors: rest });
    } else {
      this.patch({ errors: { ...errors, [key]: err } });
    }
  }

  private patch(p: Partial<RoomsState>) {
    const s = this.state;
    const changed = (Object.keys(p) as (keyof RoomsState)[]).some((k) => p[k] !== s[k]);
    if (changed) this.setState({ ...s, ...p });
  }

  private setArtifacts(roomId: string, list: Artifact[]) {
    this.patch({ artifacts: { ...this.state.artifacts, [roomId]: list } });
    this.syncCount(roomId);
  }

  /**
   * roomsd sends no room.updated when a room's documents change, so a room
   * whose artifacts are loaded takes its `artifactCount` from the list.
   */
  private syncCount(roomId: string) {
    const list = this.state.artifacts[roomId];
    if (list === undefined) return;
    const rooms = this.state.rooms;
    const i = rooms.findIndex((r) => r.id === roomId);
    if (i < 0 || rooms[i].artifactCount === list.length) return;
    this.patch({ rooms: rooms.map((r, j) => (j === i ? { ...r, artifactCount: list.length } : r)) });
  }

  private bump(tokens: Map<string, number>, key: string): number {
    const t = (tokens.get(key) ?? 0) + 1;
    tokens.set(key, t);
    return t;
  }

  // ---------------------------------------------------------------- events

  private onOpen = () => {
    if (!this.started) return;
    // A fresh connection: buffer until its leading `resync {null}` syncs us.
    this.enterBuffering();
  };

  /** Buffer events and wait for `resync {null}`; any in-flight sync is superseded. */
  private enterBuffering() {
    this.syncGen++;
    this.buffering = true;
    this.clearRetry();
    this.clearFallback();
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.beginSync();
    }, RESYNC_FALLBACK_MS);
  }

  private onEvent = (e: RoomsEvent) => {
    if (!this.started) return;
    if (e.type === "resync" && e.roomId === null) {
      this.beginSync();
      return;
    }
    if (this.buffering) {
      this.queue.push(e);
      return;
    }
    this.apply(e);
  };

  private apply(e: RoomsEvent) {
    switch (e.type) {
      case "resync": // `resync {null}` never reaches here (handled in onEvent)
        if (e.roomId !== null && this.isWatchedRoom(e.roomId)) void this.fetchRoom(e.roomId);
        return;
      case "room.added":
      case "room.updated": {
        if (e.seq <= this.roomsSeq) return;
        const rooms = this.state.rooms;
        const i = rooms.findIndex((r) => r.id === e.room.id);
        this.batch(() => {
          this.patch({ rooms: i < 0 ? [...rooms, e.room] : rooms.map((r, j) => (j === i ? e.room : r)) });
          this.syncCount(e.room.id);
        });
        this.wake(e.room.id);
        return;
      }
      case "room.removed": {
        if (e.seq <= this.roomsSeq) return;
        const rooms = this.state.rooms.filter((r) => r.id !== e.roomId);
        this.batch(() => {
          if (rooms.length !== this.state.rooms.length) this.patch({ rooms });
          this.forgetRoom(e.roomId);
        });
        return;
      }
      case "artifact.added":
      case "artifact.updated":
        this.batch(() => {
          if (e.type === "artifact.added") this.countArtifact(e.artifact.roomId, 1, e.seq);
          this.applyArtifact(e.artifact.roomId, e);
        });
        return;
      case "artifact.removed":
        this.batch(() => {
          this.countArtifact(e.roomId, -1, e.seq);
          this.applyArtifact(e.roomId, e);
        });
        return;
      case "journal.changed":
      case "note.removed":
        this.dayChanged(e.date);
        return;
      case "note.saved":
        this.dayChanged(e.note.date);
        return;
    }
  }

  /** The room left the list: drop its scope; watchers keep it dormant until it comes back. */
  private forgetRoom(roomId: string) {
    if (this.roomRefs.has(roomId)) this.dormantRooms.add(roomId);
    this.dropRoom(roomId);
  }

  /** A dormant watched room is listed again: load it. */
  private wake(roomId: string) {
    if (!this.dormantRooms.delete(roomId)) return;
    void this.fetchRoom(roomId);
  }

  /** Drops a room's scope (seq, in-flight fetch, data, error). */
  private dropRoom(roomId: string) {
    this.artifactsSeq.delete(roomId);
    this.bump(this.roomTokens, roomId);
    this.roomFetches.delete(roomId);
    if (roomId in this.state.artifacts) {
      const { [roomId]: _gone, ...artifacts } = this.state.artifacts;
      this.patch({ artifacts });
    }
    this.setError(roomKey(roomId), undefined);
  }

  /**
   * For a room whose artifacts are not loaded: moves `artifactCount` by one for
   * an artifact event newer than the rooms snapshot. Loaded rooms take their
   * count from the list instead (see `syncCount`).
   */
  private countArtifact(roomId: string, delta: 1 | -1, seq: number) {
    if (seq <= this.roomsSeq || this.state.artifacts[roomId] !== undefined) return;
    const rooms = this.state.rooms;
    const i = rooms.findIndex((r) => r.id === roomId);
    if (i < 0) return;
    const r = rooms[i];
    const artifactCount = Math.max(0, r.artifactCount + delta);
    if (artifactCount === r.artifactCount) return;
    this.patch({ rooms: rooms.map((x, j) => (j === i ? { ...r, artifactCount } : x)) });
  }

  private applyArtifact(roomId: string, e: RoomsEvent) {
    if (!this.isWatchedRoom(roomId)) return;
    const inflight = this.roomFetches.get(roomId);
    if (inflight) {
      inflight.queue.push(e);
      return;
    }
    const list = this.state.artifacts[roomId];
    const seq = this.artifactsSeq.get(roomId);
    if (list === undefined || seq === undefined || e.seq <= seq) return;
    if (e.type === "artifact.removed") {
      if (list.some((a) => a.id === e.artifactId)) this.setArtifacts(roomId, list.filter((a) => a.id !== e.artifactId));
    } else if (e.type === "artifact.added" || e.type === "artifact.updated") {
      const a = e.artifact;
      this.setArtifacts(roomId, sortArtifacts([...list.filter((x) => x.id !== a.id), a]));
    }
  }

  private dayChanged(date: string) {
    if (!this.isWatchedDay(date)) return;
    const prev = this.dayTimers.get(date);
    if (prev) clearTimeout(prev);
    this.dayTimers.set(
      date,
      setTimeout(() => {
        this.dayTimers.delete(date);
        void this.fetchDay(date);
      }, DAY_DEBOUNCE_MS),
    );
  }

  // ---------------------------------------------------------------- per-scope fetches

  /** Fetch one room's artifacts outside a full sync; its events queue until the snapshot lands. */
  private fetchRoom(roomId: string): Promise<void> {
    const token = this.bump(this.roomTokens, roomId);
    const queue = this.roomFetches.get(roomId)?.queue ?? [];
    const entry: RoomFetch = { token, queue, promise: Promise.resolve() };
    entry.promise = this.client.listArtifacts(roomId).then(
      (snap) => {
        if (this.roomTokens.get(roomId) !== token) return;
        this.roomFetches.delete(roomId);
        if (!this.isWatchedRoom(roomId)) return;
        this.batch(() => {
          this.artifactsSeq.set(roomId, snap.seq);
          this.setArtifacts(roomId, sortArtifacts(snap.data));
          this.setError(roomKey(roomId), undefined);
          for (const e of entry.queue) this.applyArtifact(roomId, e);
        });
      },
      (err) => {
        if (this.roomTokens.get(roomId) !== token) return;
        this.roomFetches.delete(roomId);
        this.warn(`rooms: failed to load artifacts for ${roomId}`, err);
        // Keep previous data; queued events still apply against the previous snapshot seq.
        this.batch(() => {
          this.setError(roomKey(roomId), message(err));
          for (const e of entry.queue) this.applyArtifact(roomId, e);
        });
      },
    );
    this.roomFetches.set(roomId, entry);
    return entry.promise;
  }

  private fetchDay(date: string): Promise<void> {
    const token = this.bump(this.dayTokens, date);
    const p = this.client.journalDay(date).then(
      (snap) => {
        if (this.dayTokens.get(date) !== token) return;
        this.dayFetches.delete(date);
        this.batch(() => {
          this.patch({ days: { ...this.state.days, [date]: snap.data } });
          this.setError(dayKey(date), undefined);
        });
      },
      (err) => {
        if (this.dayTokens.get(date) !== token) return;
        this.dayFetches.delete(date);
        this.warn(`rooms: failed to load journal day ${date}`, err);
        this.setError(dayKey(date), message(err));
      },
    );
    this.dayFetches.set(date, p);
    return p;
  }

  // ---------------------------------------------------------------- full sync

  private beginSync() {
    if (!this.started) return;
    this.clearRetry();
    this.clearFallback();
    const gen = ++this.syncGen;
    this.buffering = true;

    // Standalone fetches started before this sync are superseded by it; the
    // events they queued predate this snapshot, so dropping them is safe.
    const rooms = [...this.roomRefs.keys()].filter((id) => this.isWatchedRoom(id));
    const dayList = [...this.dayRefs.keys()];
    const roomToks = rooms.map((id) => this.bump(this.roomTokens, id));
    const dayToks = dayList.map((d) => this.bump(this.dayTokens, d));
    for (const id of rooms) this.roomFetches.delete(id);
    for (const d of dayList) this.dayFetches.delete(d);

    const info = this.client.info();
    const list = this.client.listRooms();
    const arts = rooms.map((id) => this.client.listArtifacts(id));
    const dayPs = dayList.map((d) => this.client.journalDay(d));

    void Promise.allSettled([info, list, ...arts, ...dayPs]).then((results) => {
      if (gen !== this.syncGen) return; // a newer sync (or stop) superseded this one
      const [infoR, listR] = results as [PromiseSettledResult<Info>, PromiseSettledResult<Snapshot<Room[]>>];
      const artRs = results.slice(2, 2 + rooms.length) as PromiseSettledResult<Snapshot<Artifact[]>>[];
      const dayRs = results.slice(2 + rooms.length) as PromiseSettledResult<Snapshot<JournalDay>>[];

      if (infoR.status === "rejected" || listR.status === "rejected") {
        // stay buffering until a retry succeeds
        this.warn("rooms: sync failed", infoR.status === "rejected" ? infoR.reason : (listR as PromiseRejectedResult).reason);
        this.patch({ status: "error" });
        this.scheduleRetry();
        return;
      }

      this.roomsSeq = listR.value.seq;
      // Rooms gone from the list (e.g. deleted while disconnected) lose their
      // scope. The journal room is never listed, so it is exempt.
      const present = new Set(listR.value.data.map((r) => r.id));
      present.add(infoR.value.journalRoomId);

      this.retryAttempt = 0;
      this.buffering = false;
      const queued = this.queue;
      this.queue = [];

      // Snapshot + drain land as one state change: listeners hear it once.
      this.batch(() => {
        let artifacts = this.state.artifacts;
        let errors = this.state.errors;
        const vanished: string[] = [];
        rooms.forEach((id, i) => {
          const r = artRs[i];
          if (this.roomTokens.get(id) !== roomToks[i] || !this.isWatchedRoom(id)) return;
          if (!present.has(id)) {
            vanished.push(id);
            return;
          }
          if (r.status === "fulfilled") {
            this.artifactsSeq.set(id, r.value.seq);
            artifacts = { ...artifacts, [id]: sortArtifacts(r.value.data) };
            if (roomKey(id) in errors) {
              const { [roomKey(id)]: _ok, ...rest } = errors;
              errors = rest;
            }
          } else {
            this.warn(`rooms: failed to resync artifacts for ${id}`, r.reason);
            errors = { ...errors, [roomKey(id)]: message(r.reason) };
          }
        });
        let days = this.state.days;
        dayList.forEach((d, i) => {
          const r = dayRs[i];
          if (this.dayTokens.get(d) !== dayToks[i]) return;
          if (r.status === "fulfilled") {
            days = { ...days, [d]: r.value.data };
            if (dayKey(d) in errors) {
              const { [dayKey(d)]: _ok, ...rest } = errors;
              errors = rest;
            }
          } else {
            this.warn(`rooms: failed to resync journal day ${d}`, r.reason);
            errors = { ...errors, [dayKey(d)]: message(r.reason) };
          }
        });

        this.patch({ status: "live", info: infoR.value, rooms: listR.value.data, artifacts, days, errors });
        for (const id of vanished) this.forgetRoom(id);
        for (const r of listR.value.data) this.syncCount(r.id);
        // Dormant watched rooms that are listed again reload on their own.
        for (const id of [...this.dormantRooms]) if (present.has(id)) this.wake(id);

        // Drain in arrival order under the per-scope rule. Nothing here can restart
        // the sync (resync {null} is never queued), so the drain runs to completion.
        for (const e of queued) this.apply(e);
      });
    });
  }

  private scheduleRetry() {
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.retryAttempt, BACKOFF_MAX_MS);
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.beginSync();
    }, delay);
  }

  private clearFallback() {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
