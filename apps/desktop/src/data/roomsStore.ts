import type { Artifact, Info, JournalDay, Room, RoomsEvent, Snapshot } from "@alto-rooms/protocol-ts";
import { globalTimers, type Clock } from "@/lib/clock";
import { applyArtifactEvent, applyEvent, type Applied, type Intent, type ScopeView } from "./roomsEvents";
import { dayKey, patch, roomKey, sortArtifacts, syncCount, withArtifacts, withError, type RoomsState } from "./roomsState";
import { ScopeRefs } from "./scopeRefs";

export type { RoomsState } from "./roomsState";

export type RoomsClientLike = {
  info(): Promise<Info>;
  listRooms(): Promise<Snapshot<Room[]>>;
  listArtifacts(roomId: string): Promise<Snapshot<Artifact[]>>;
  journalDay(date: string): Promise<Snapshot<JournalDay>>;
  subscribe(onEvent: (e: RoomsEvent) => void, onOpen?: () => void): () => void;
};

export type RoomsStoreOptions = {
  /** Non-fatal problems (one scope failed to refetch). Defaults to console.warn. */
  warn?: (...args: unknown[]) => void;
  /** Clock for every store timer (tests). Defaults to the global timers, looked up at call time. */
  timers?: Clock;
};

/** How long a scope stays watched after its last watcher leaves (e.g. a tab switch and back). */
export const UNWATCH_LINGER_MS = 45_000;

const DAY_DEBOUNCE_MS = 150;
/** If the server's leading `resync {null}` doesn't arrive within this, sync anyway. */
const RESYNC_FALLBACK_MS = 2000;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s, 8s, then capped
const BACKOFF_MAX_MS = 10_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
 * lets go, the scope lingers, still fully watched, for UNWATCH_LINGER_MS; a
 * new watcher in that window keeps it as is. After that its data is dropped
 * and it is no longer refetched. A watched
 * room that disappears from the room list goes dormant (data dropped, not
 * fetched) and reloads by itself when it comes back.
 */
export class RoomsStore {
  private state: RoomsState = { status: "connecting", info: null, rooms: [], artifacts: {}, days: {}, errors: {}, syncFailures: 0 };
  private listeners = new Set<() => void>();
  private batchDepth = 0;
  private dirty = false;
  private readonly warn: (...args: unknown[]) => void;
  private readonly timers: Clock;

  private started = false;
  private unsubscribe: (() => void) | null = null;

  // Global sync.
  private syncGen = 0;
  private buffering = false;
  private queue: RoomsEvent[] = [];
  private retryAttempt = 0;
  private retryTimer: unknown = null;
  private fallbackTimer: unknown = null;

  // Rooms scope.
  private roomsSeq = 0;

  // Artifact scopes, and watched rooms currently absent from the list.
  private readonly roomScopes: ScopeRefs<string, RoomFetch>;
  private dormantRooms = new Set<string>();
  private artifactsSeq = new Map<string, number>();

  // Day scopes (refetch-only), and their refetch debounce.
  private readonly dayScopes: ScopeRefs<string, Promise<void>>;
  private dayTimers = new Map<string, unknown>();

  constructor(
    private readonly client: RoomsClientLike,
    opts: RoomsStoreOptions = {},
  ) {
    this.warn = opts.warn ?? ((...args) => console.warn(...args));
    this.timers = opts.timers ?? globalTimers;
    this.roomScopes = new ScopeRefs(this.timers, UNWATCH_LINGER_MS, (id) => this.expireRoom(id));
    this.dayScopes = new ScopeRefs(this.timers, UNWATCH_LINGER_MS, (date) => this.expireDay(date));
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
    // A restart begins from scratch: no stale error or failure count.
    this.retryAttempt = 0;
    this.patch({ status: "connecting", syncFailures: 0 });
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
    for (const t of this.dayTimers.values()) this.timers.clearTimeout(t);
    this.dayTimers.clear();
    this.roomScopes.supersedeAll();
    this.dayScopes.supersedeAll();
    // Nobody is coming back to a stopped store's lingering scopes.
    this.roomScopes.expireLingering();
    this.dayScopes.expireLingering();
  }

  /**
   * Adds a watcher to the room (refetched on every resync while watched) and
   * loads it once. Pair every call with `unwatchArtifacts(roomId)`.
   */
  loadArtifacts(roomId: string): Promise<void> {
    this.roomScopes.acquire(roomId);
    if (this.dormantRooms.has(roomId)) return Promise.resolve();
    const inflight = this.roomScopes.inflight(roomId);
    if (inflight) return inflight.promise;
    if (this.state.artifacts[roomId] !== undefined) return Promise.resolve();
    return this.fetchRoom(roomId);
  }

  /** Removes a watcher; UNWATCH_LINGER_MS after the last one leaves, the room's artifacts are dropped. */
  unwatchArtifacts(roomId: string): void {
    this.roomScopes.release(roomId);
  }

  /**
   * Adds a watcher to the day (refetched on resync and journal/note events)
   * and loads it once. Pair every call with `unwatchDay(date)`.
   */
  loadDay(date: string): Promise<void> {
    this.dayScopes.acquire(date);
    const inflight = this.dayScopes.inflight(date);
    if (inflight) return inflight;
    if (this.state.days[date] !== undefined) return Promise.resolve();
    return this.fetchDay(date);
  }

  /** Removes a watcher; UNWATCH_LINGER_MS after the last one leaves, the day is dropped. */
  unwatchDay(date: string): void {
    this.dayScopes.release(date);
  }

  private signalListeners = new Set<(type: RoomsEvent["type"], e: RoomsEvent) => void>();

  /** Hears every event as it arrives (before buffering): for state kept outside this store, e.g. plugins, asks. */
  onSignal = (fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): (() => void) => {
    this.signalListeners.add(fn);
    return () => void this.signalListeners.delete(fn);
  };

  // ---------------------------------------------------------------- scopes

  /** Watched (or lingering) and present in the room list (or not yet known to be absent). */
  private isWatchedRoom(roomId: string): boolean {
    return this.roomScopes.has(roomId) && !this.dormantRooms.has(roomId);
  }

  private expireRoom(roomId: string) {
    this.dormantRooms.delete(roomId);
    this.batch(() => this.dropRoom(roomId));
  }

  private expireDay(date: string) {
    const timer = this.dayTimers.get(date);
    if (timer !== undefined) this.timers.clearTimeout(timer);
    this.dayTimers.delete(date);
    this.dayScopes.supersede(date);
    this.batch(() => {
      if (date in this.state.days) {
        const { [date]: _gone, ...days } = this.state.days;
        this.patch({ days });
      }
      this.setError(dayKey(date), undefined);
    });
  }

  /** The room left the list: drop its scope; watchers keep it dormant until it comes back. */
  private forgetRoom(roomId: string) {
    if (this.roomScopes.has(roomId)) this.dormantRooms.add(roomId);
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
    this.roomScopes.supersede(roomId);
    if (roomId in this.state.artifacts) {
      const { [roomId]: _gone, ...artifacts } = this.state.artifacts;
      this.patch({ artifacts });
    }
    this.setError(roomKey(roomId), undefined);
  }

  /** Debounced refetch of a watched day. */
  private dayChanged(date: string) {
    const prev = this.dayTimers.get(date);
    if (prev !== undefined) this.timers.clearTimeout(prev);
    this.dayTimers.set(
      date,
      this.timers.setTimeout(() => {
        this.dayTimers.delete(date);
        void this.fetchDay(date);
      }, DAY_DEBOUNCE_MS),
    );
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

  private patch(p: Partial<RoomsState>) {
    this.setState(patch(this.state, p));
  }

  private setError(key: string, err: string | undefined) {
    this.setState(withError(this.state, key, err));
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
    this.fallbackTimer = this.timers.setTimeout(() => {
      this.fallbackTimer = null;
      this.beginSync();
    }, RESYNC_FALLBACK_MS);
  }

  private onEvent = (e: RoomsEvent) => {
    if (!this.started) return;
    for (const l of [...this.signalListeners]) l(e.type, e);
    if (e.type === "plugins.changed") return;
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

  /** The reducer's read-only window onto the scopes. */
  private readonly view: ScopeView = {
    roomsSeq: () => this.roomsSeq,
    artifactsSeq: (roomId) => this.artifactsSeq.get(roomId),
    isWatchedRoom: (roomId) => this.isWatchedRoom(roomId),
    isFetchingRoom: (roomId) => this.roomScopes.inflight(roomId) !== undefined,
    isWatchedDay: (date) => this.dayScopes.has(date),
  };

  private apply(e: RoomsEvent) {
    this.commit(applyEvent(this.state, e, this.view));
  }

  /** Takes the reducer's state and carries out its intents; listeners hear it once. */
  private commit({ state, intents }: Applied) {
    this.batch(() => {
      this.setState(state);
      for (const intent of intents) this.run(intent);
    });
  }

  private run(intent: Intent) {
    switch (intent.type) {
      case "fetchRoom":
        void this.fetchRoom(intent.roomId);
        return;
      case "wakeRoom":
        this.wake(intent.roomId);
        return;
      case "forgetRoom":
        this.forgetRoom(intent.roomId);
        return;
      case "queueArtifact":
        this.roomScopes.inflight(intent.roomId)?.queue.push(intent.event);
        return;
      case "dayChanged":
        this.dayChanged(intent.date);
        return;
    }
  }

  /** Replays events queued while a room's snapshot was in flight. */
  private drainRoom(roomId: string, queue: RoomsEvent[]) {
    for (const e of queue) this.commit(applyArtifactEvent(this.state, roomId, e, this.view));
  }

  // ---------------------------------------------------------------- per-scope fetches

  /** Fetch one room's artifacts outside a full sync; its events queue until the snapshot lands. */
  private fetchRoom(roomId: string): Promise<void> {
    const scopes = this.roomScopes;
    const token = scopes.bump(roomId);
    const queue = scopes.inflight(roomId)?.queue ?? [];
    const entry: RoomFetch = { token, queue, promise: Promise.resolve() };
    entry.promise = this.client.listArtifacts(roomId).then(
      (snap) => {
        if (!scopes.isCurrent(roomId, token)) return;
        scopes.settle(roomId);
        if (!this.isWatchedRoom(roomId)) return;
        this.batch(() => {
          this.artifactsSeq.set(roomId, snap.seq);
          this.setState(withArtifacts(this.state, roomId, sortArtifacts(snap.data)));
          this.setError(roomKey(roomId), undefined);
          this.drainRoom(roomId, entry.queue);
        });
      },
      (err) => {
        if (!scopes.isCurrent(roomId, token)) return;
        scopes.settle(roomId);
        this.warn(`rooms: failed to load artifacts for ${roomId}`, err);
        // Keep previous data; queued events still apply against the previous snapshot seq.
        this.batch(() => {
          this.setError(roomKey(roomId), message(err));
          this.drainRoom(roomId, entry.queue);
        });
      },
    );
    scopes.track(roomId, entry);
    return entry.promise;
  }

  private fetchDay(date: string): Promise<void> {
    const scopes = this.dayScopes;
    const token = scopes.bump(date);
    const p = this.client.journalDay(date).then(
      (snap) => {
        if (!scopes.isCurrent(date, token)) return;
        scopes.settle(date);
        this.batch(() => {
          this.patch({ days: { ...this.state.days, [date]: snap.data } });
          this.setError(dayKey(date), undefined);
        });
      },
      (err) => {
        if (!scopes.isCurrent(date, token)) return;
        scopes.settle(date);
        this.warn(`rooms: failed to load journal day ${date}`, err);
        this.setError(dayKey(date), message(err));
      },
    );
    scopes.track(date, p);
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
    const rooms = this.roomScopes.keys().filter((id) => this.isWatchedRoom(id));
    const dayList = this.dayScopes.keys();
    const roomToks = rooms.map((id) => this.roomScopes.supersede(id));
    const dayToks = dayList.map((d) => this.dayScopes.supersede(d));

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
        this.patch({ status: "error", syncFailures: this.state.syncFailures + 1 });
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
          if (!this.roomScopes.isCurrent(id, roomToks[i]) || !this.isWatchedRoom(id)) return;
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
          if (!this.dayScopes.isCurrent(d, dayToks[i])) return;
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

        this.patch({ status: "live", info: infoR.value, rooms: listR.value.data, artifacts, days, errors, syncFailures: 0 });
        for (const id of vanished) this.forgetRoom(id);
        for (const r of listR.value.data) this.setState(syncCount(this.state, r.id));
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
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.beginSync();
    }, delay);
  }

  private clearFallback() {
    if (this.fallbackTimer !== null) this.timers.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private clearRetry() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
