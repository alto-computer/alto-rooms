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
  /** Replaces the save function (a new daemon connection); the next save uses it. */
  setSave(save: (text: string) => Promise<{ updatedAt: string }>): void;
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
  let save = opts.save;
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
    save(text).catch((err) => warn("note: unsaved changes could not be saved after closing", err));
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
    save(text).then(
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
    setSave(next) {
      save = next;
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

/** Which note a saver writes; lets the registry rebind it to a new client and keep drafts. */
export type NoteTarget = { date: string; name: string };

type Entry = { saver: NoteSaver; views: number; unsubscribe: () => void; target?: NoteTarget };
const registry = new Map<string, Entry>();

/**
 * Registry key: `${date}/${fileName}` with the file name as on disk (with
 * `.md`), NFC and lowercased, so `Plan.md` and `plan.md` (one file on macOS's
 * case-insensitive disk) share a saver.
 */
export const noteSaverKey = (date: string, fileName: string) => `${date}/${fileName.normalize("NFC").toLowerCase()}`;

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

/** A save landed and nothing is unsaved: any draft kept for this note is obsolete. */
function clearDraftIfLanded(e: Entry) {
  const s = e.saver.getState();
  if (e.target && s.status === "saved" && !s.inFlight && s.text === s.savedText) clearNoteDraft(e.target.date, e.target.name);
}

/**
 * Attaches a view to the note's live saver, creating it (`fresh`) if there is
 * none. Pass `target` so the saver can be rebound to a new connection and its
 * text kept as a draft if it can't be saved before quitting.
 */
export function attachNoteSaver(key: string, create: () => NoteSaver, target?: NoteTarget): { saver: NoteSaver; fresh: boolean } {
  const existing = registry.get(key);
  if (existing) {
    existing.views++;
    existing.target ??= target;
    return { saver: existing.saver, fresh: false };
  }
  const saver = create();
  const entry: Entry = { saver, views: 1, unsubscribe: () => {}, target };
  entry.unsubscribe = saver.subscribe(() => {
    clearDraftIfLanded(entry);
    releaseIfIdle(key, entry);
  });
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

export type SaveNoteFn = (date: string, name: string, text: string) => Promise<{ updatedAt: string }>;

/**
 * A new daemon connection: every live saver now saves through `saveNote`
 * instead of the old client. Savers that have failed retry right away.
 */
export function rebindNoteSavers(saveNote: SaveNoteFn): void {
  for (const e of registry.values()) {
    const t = e.target;
    if (!t) continue;
    e.saver.setSave((text) => saveNote(t.date, t.name, text));
    if (e.saver.getState().failures > 0) e.saver.flush();
  }
}

/*
 * Drafts: a note that still could not be saved when the app quits keeps its
 * text in localStorage (text only, never a token) until a later save lands.
 */
const DRAFT_PREFIX = "alto-rooms.note-draft.v1:";
/** `alto-rooms.note-draft.v1:${date}/${file}`, the file part folded like the registry key. */
export const noteDraftKey = (date: string, fileName: string) => `${DRAFT_PREFIX}${noteSaverKey(date, fileName)}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readNoteDraft(date: string, fileName: string): string | null {
  try {
    return storage()?.getItem(noteDraftKey(date, fileName)) ?? null;
  } catch {
    return null;
  }
}

export function clearNoteDraft(date: string, fileName: string): void {
  try {
    storage()?.removeItem(noteDraftKey(date, fileName));
  } catch {
    // Storage unavailable: nothing was kept there either.
  }
}

/** Keeps the text of every note that has not landed (in error, or still unsaved) as a draft. Returns how many. */
export function keepUnsavedNoteDrafts(): number {
  let kept = 0;
  for (const e of registry.values()) {
    const s = e.saver.getState();
    if (!e.target || !s.ready || (s.text === s.savedText && !s.inFlight)) continue;
    try {
      storage()?.setItem(noteDraftKey(e.target.date, e.target.name), s.text);
      kept++;
    } catch (err) {
      console.warn("note: could not keep a draft", err);
    }
  }
  return kept;
}

/** Saves every dirty note now (the app is quitting or hiding). */
export function flushAllNoteSavers(): void {
  for (const e of registry.values()) e.saver.flush();
}

const settled = (s: NoteSaver) => {
  const st = s.getState();
  return !st.inFlight && st.text === st.savedText;
};

/**
 * Flushes every dirty note and resolves once all of them have landed (nothing
 * unsaved, nothing in flight) or after `timeoutMs`, whichever comes first.
 * Resolves `true` when everything landed. Never rejects.
 */
export function flushAllNoteSaversAndWait(timeoutMs = 2000): Promise<boolean> {
  const savers = [...registry.values()].map((e) => e.saver);
  for (const s of savers) s.flush();
  if (savers.every(settled)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const unsubs: (() => void)[] = [];
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const u of unsubs) u();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const check = () => {
      if (savers.every(settled)) finish(true);
    };
    for (const s of savers) unsubs.push(s.subscribe(check));
  });
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
