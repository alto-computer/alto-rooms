/*
 * Autosave for one note, framework-free and driven by an injectable clock.
 *
 * - A save starts DEBOUNCE_MS after the last edit, or right away on blur.
 * - At most one save is in flight. Edits made meanwhile cause exactly one
 *   follow-up save of the latest text once it settles.
 * - Failures retry after 1s, 2s, 4s; from the 3rd consecutive failure the
 *   status is "error" and retries continue every 10s. A success resets that.
 * - Local text is never discarded: only a load or a remote body applied while
 *   there are no unsaved edits replaces it.
 * - dispose() (unmount) fires one last save of anything unsaved; its failure
 *   is logged through `warn`, as nobody is left to show it to.
 */

export const DEBOUNCE_MS = 800;
export const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
/** Consecutive failures after which the status becomes "error". */
export const ERROR_AFTER_FAILURES = 3;
export const SLOW_RETRY_MS = 10_000;

export type NoteSaverStatus = "idle" | "saving" | "error" | "saved";

export type NoteSaverState = {
  /** Local text (what the textarea shows). */
  text: string;
  /** Last text the server acknowledged (or loaded). */
  savedText: string;
  inFlight: boolean;
  /** The text changed while a save was in flight. */
  dirtyDuringFlight: boolean;
  /** Consecutive failed saves. */
  failures: number;
  status: NoteSaverStatus;
  /** Edits are ignored until the body has been loaded. */
  ready: boolean;
  /** `updatedAt` of the last load or acknowledged save; newer ones are external changes. */
  knownUpdatedAt: string | null;
};

export type Clock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Looks the globals up at call time, so fake timers installed later still apply. */
const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type NoteSaverOptions = {
  save: (text: string) => Promise<{ updatedAt: string }>;
  clock?: Clock;
  warn?: (...args: unknown[]) => void;
};

export type NoteSaver = {
  getState(): NoteSaverState;
  subscribe(listener: () => void): () => void;
  /** Sets the loaded body (both text and savedText) and allows edits. */
  load(text: string, updatedAt: string | null): void;
  /** Applies an externally changed body if there are no unsaved edits and nothing in flight. */
  applyRemote(text: string, updatedAt: string | null): boolean;
  edit(text: string): void;
  blur(): void;
  /** True when `updatedAt` is strictly newer than the last load or acknowledged save. */
  isNewer(updatedAt: string): boolean;
  isDirty(): boolean;
  /** Saves now, skipping the debounce or a pending retry (e.g. the app is quitting). */
  flush(): void;
  /** Hard stop: one last save of unsaved text, then nothing more. */
  dispose(): void;
  /** Stops without saving anything (tests). */
  stop(): void;
};

/** a > b, as instants when both parse, else as strings. */
function later(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb;
  return a > b;
}

export function createNoteSaver(opts: NoteSaverOptions): NoteSaver {
  const clock = opts.clock ?? realClock;
  const warn = opts.warn ?? ((...args: unknown[]) => console.warn(...args));
  const listeners = new Set<() => void>();
  let state: NoteSaverState = {
    text: "",
    savedText: "",
    inFlight: false,
    dirtyDuringFlight: false,
    failures: 0,
    status: "idle",
    ready: false,
    knownUpdatedAt: null,
  };
  let timer: unknown = null;
  let disposed = false;
  let finalSent = false;

  const set = (p: Partial<NoteSaverState>) => {
    state = { ...state, ...p };
    for (const l of [...listeners]) l();
  };

  const dirty = () => state.text !== state.savedText;

  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms: number) => {
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      saveNow();
    }, ms);
  };

  const remember = (updatedAt: string | null) => {
    if (updatedAt && (state.knownUpdatedAt === null || later(updatedAt, state.knownUpdatedAt))) return updatedAt;
    return state.knownUpdatedAt;
  };

  /** After unmount: one fire-and-forget save of whatever is still unsaved. */
  const finalSave = () => {
    if (finalSent || !dirty()) return;
    finalSent = true;
    const text = state.text;
    opts.save(text).catch((err) => warn("note: unsaved changes could not be saved after closing", err));
  };

  function saveNow() {
    if (!state.ready || disposed) return;
    if (state.inFlight) {
      if (dirty()) set({ dirtyDuringFlight: true });
      return;
    }
    if (!dirty()) return;
    clearTimer();
    const text = state.text;
    set({ inFlight: true, dirtyDuringFlight: false, status: state.status === "error" ? "error" : "saving" });
    opts.save(text).then(
      (res) => {
        set({
          inFlight: false,
          dirtyDuringFlight: false,
          savedText: text,
          failures: 0,
          status: "saved",
          knownUpdatedAt: remember(res?.updatedAt ?? null),
        });
        if (disposed) {
          finalSave();
          return;
        }
        // Edits made meanwhile: one follow-up save of the latest text,
        // unless their debounce is still pending (it will save then).
        if (dirty() && timer === null) saveNow();
      },
      (err) => {
        const failures = state.failures + 1;
        set({ inFlight: false, dirtyDuringFlight: false, failures, status: failures >= ERROR_AFTER_FAILURES ? "error" : "saving" });
        if (disposed) {
          if (!finalSent) {
            warn("note: save failed while closing; retrying once", err);
            finalSave();
          }
          return;
        }
        // An edit's pending debounce saves sooner than the backoff; otherwise back off.
        if (timer === null) schedule(RETRY_DELAYS_MS[failures - 1] ?? SLOW_RETRY_MS);
      },
    );
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(text, updatedAt) {
      clearTimer();
      set({ text, savedText: text, ready: true, dirtyDuringFlight: false, knownUpdatedAt: remember(updatedAt) });
    },
    applyRemote(text, updatedAt) {
      if (!state.ready || state.inFlight || dirty()) return false;
      set({ text, savedText: text, knownUpdatedAt: remember(updatedAt) });
      return true;
    },
    edit(text) {
      if (!state.ready || disposed || text === state.text) return;
      set({ text, dirtyDuringFlight: state.inFlight ? true : state.dirtyDuringFlight });
      schedule(DEBOUNCE_MS);
    },
    blur() {
      if (!state.ready || disposed) return;
      if (dirty() && !state.inFlight) saveNow();
    },
    isNewer(updatedAt) {
      return state.knownUpdatedAt === null || later(updatedAt, state.knownUpdatedAt);
    },
    isDirty: dirty,
    flush() {
      if (!state.ready || disposed || !dirty()) return;
      clearTimer(); // an in-flight save then follows up immediately when it settles
      if (state.inFlight) set({ dirtyDuringFlight: true });
      else saveNow();
    },
    stop() {
      disposed = true;
      finalSent = true;
      clearTimer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      if (!state.inFlight) finalSave();
      // else: the in-flight save's settlement sends whatever is still unsaved.
    },
  };
}

/*
 * Registry: one live saver per note file, shared across mounts.
 *
 * A note view attaches on mount and detaches on unmount. A detached saver
 * stays alive, and keeps its schedule (debounce, then retries), for as long as
 * it has unsaved text or a save in flight; it is released once it is clean and
 * idle with no view attached. Reopening a note while its saver is alive
 * attaches to it (and shows its local text) instead of reloading from disk.
 */

type Entry = { saver: NoteSaver; views: number; unsubscribe: () => void };
const registry = new Map<string, Entry>();

/** Registry key: `${date}/${fileName}`, the file name as on disk (with `.md`). */
export const noteSaverKey = (date: string, fileName: string) => `${date}/${fileName}`;

const releasable = (e: Entry) => {
  const s = e.saver.getState();
  return e.views === 0 && !s.inFlight && s.text === s.savedText;
};

function releaseIfIdle(key: string, e: Entry) {
  if (registry.get(key) !== e || !releasable(e)) return;
  registry.delete(key);
  e.unsubscribe();
  e.saver.dispose(); // clean: sends nothing, just stops it
}

/** Attaches a view to the note's live saver, creating it (`fresh`) if there is none. */
export function attachNoteSaver(key: string, create: () => NoteSaver): { saver: NoteSaver; fresh: boolean } {
  const existing = registry.get(key);
  if (existing) {
    existing.views++;
    return { saver: existing.saver, fresh: false };
  }
  const saver = create();
  const entry: Entry = { saver, views: 1, unsubscribe: () => {} };
  entry.unsubscribe = saver.subscribe(() => releaseIfIdle(key, entry));
  registry.set(key, entry);
  installQuitFlush();
  return { saver, fresh: true };
}

/** Detaches a view. The saver lives on until it is clean and idle. */
export function detachNoteSaver(key: string, saver: NoteSaver): void {
  const e = registry.get(key);
  if (!e || e.saver !== saver) return;
  e.views = Math.max(0, e.views - 1);
  releaseIfIdle(key, e);
}

/** Saves every dirty note now (the app is quitting or hiding). */
export function flushAllNoteSavers(): void {
  for (const e of registry.values()) e.saver.flush();
}

let quitFlushInstalled = false;
function installQuitFlush() {
  if (quitFlushInstalled || typeof window === "undefined") return;
  quitFlushInstalled = true;
  window.addEventListener("pagehide", flushAllNoteSavers);
  window.addEventListener("beforeunload", flushAllNoteSavers);
}

/** Keys of the live savers (for tests and diagnostics). */
export function noteSaverKeys(): string[] {
  return [...registry.keys()];
}

/** Tests only: stops and forgets every saver without saving. */
export function resetNoteSavers(): void {
  for (const e of registry.values()) {
    e.unsubscribe();
    e.saver.stop();
  }
  registry.clear();
}
