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
  dispose(): void;
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
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      if (!state.inFlight) finalSave();
      // else: the in-flight save's settlement sends whatever is still unsaved.
    },
  };
}
