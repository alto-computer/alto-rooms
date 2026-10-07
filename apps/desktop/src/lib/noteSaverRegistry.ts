/*
 * Registry: one live saver per note file, shared across mounts.
 *
 * A note view attaches on mount and detaches on unmount. A detached saver
 * stays alive, and keeps its schedule (debounce, then retries), for as long as
 * it has unsaved text or a save in flight; it is released once it is clean and
 * idle with no view attached. Reopening a note while its saver is alive
 * attaches to it (and shows its local text) instead of reloading from disk.
 *
 * It also owns quitting: flushing every saver, and keeping drafts of what
 * could not be saved (see `drafts.ts`).
 */

import { clearNoteDraft, forgetKnownNoteDrafts, hasKnownNoteDraft, keepNoteDraft, textHash } from "./drafts";
import type { NoteSaver } from "./noteSaver";
import { noteKey } from "./notes";

/** Which note a saver writes; lets the registry rebind it to a new client and keep drafts. */
export type NoteTarget = { date: string; name: string };

type Entry = { key: string; saver: NoteSaver; views: number; unsubscribe: () => void; target?: NoteTarget };
const registry = new Map<string, Entry>();

/** Registry key for a note file; see `noteKey`. */
export const noteSaverKey = noteKey;

const releasable = (e: Entry) => {
  const s = e.saver.getState();
  return e.views === 0 && !s.inFlight && s.text === s.savedText;
};

function releaseIfIdle(e: Entry) {
  if (registry.get(e.key) !== e || !releasable(e)) return;
  registry.delete(e.key);
  e.unsubscribe();
  e.saver.dispose(); // clean: sends nothing, just stops it
}

/** A save landed and nothing is unsaved: any draft kept for this note is obsolete. */
function clearDraftIfLanded(e: Entry) {
  const s = e.saver.getState();
  if (!e.target || s.status !== "saved" || s.inFlight || s.text !== s.savedText) return;
  if (hasKnownNoteDraft(e.target.date, e.target.name)) void clearNoteDraft(e.target.date, e.target.name);
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
  const entry: Entry = { key, saver, views: 1, unsubscribe: () => {}, target };
  entry.unsubscribe = saver.subscribe(() => {
    clearDraftIfLanded(entry);
    releaseIfIdle(entry);
  });
  registry.set(key, entry);
  installQuitFlush();
  return { saver, fresh: true };
}

/**
 * Detaches a view. The saver lives on until it is clean and idle. A view
 * mounted before a rename detaches with its old key; the saver is found by
 * identity then.
 */
export function detachNoteSaver(key: string, saver: NoteSaver): void {
  const byKey = registry.get(key);
  const e = byKey?.saver === saver ? byKey : [...registry.values()].find((x) => x.saver === saver);
  if (!e) return;
  e.views = Math.max(0, e.views - 1);
  releaseIfIdle(e);
}

export type SaveNoteFn = (date: string, name: string, text: string) => Promise<{ updatedAt: string }>;

/**
 * The note's file was renamed: its live saver (if any) moves to `newKey`, now
 * writes `target` through `saveNote`, and keeps its views, text and schedule.
 * Call it after the rename landed and before the view switches to the new
 * name, so that view attaches to this saver instead of loading a fresh one.
 * Refuses (returns false, both savers untouched) when another live saver
 * already holds `newKey`, so a dirty saver is never overwritten.
 */
export function renameNoteSaver(oldKey: string, newKey: string, target: NoteTarget, saveNote: SaveNoteFn): boolean {
  if (newKey !== oldKey && noteSaverLive(newKey)) return false;
  const e = registry.get(oldKey);
  if (!e) return true;
  e.saver.setSave((text) => saveNote(target.date, target.name, text));
  e.target = target;
  if (newKey === oldKey) return true;
  registry.delete(oldKey);
  e.key = newKey;
  registry.set(newKey, e);
  return true;
}

/** Whether a saver is live under `key`. */
export function noteSaverLive(key: string): boolean {
  return registry.has(key);
}

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

/**
 * Keeps the text of every note that has not landed (in error, or still
 * unsaved) as a draft, with the hash of the last disk body its saver knew.
 * Resolves once every write has finished (or failed). Returns how many were kept.
 */
export async function keepUnsavedNoteDrafts(): Promise<number> {
  const writes: Promise<boolean>[] = [];
  for (const e of registry.values()) {
    const s = e.saver.getState();
    if (!e.target || !s.ready || (s.text === s.savedText && !s.inFlight)) continue;
    writes.push(keepNoteDraft(e.target.date, e.target.name, { text: s.text, baseHash: textHash(s.savedText) }));
  }
  return (await Promise.all(writes)).filter(Boolean).length;
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
  return waitSettled(
    [...registry.values()].map((e) => e.saver),
    timeoutMs,
  );
}

/** Flushes `savers` and resolves `true` once all have landed, or `false` after `timeoutMs`. */
function waitSettled(savers: NoteSaver[], timeoutMs: number): Promise<boolean> {
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

/**
 * Saves one note now and resolves once it has landed (nothing unsaved,
 * nothing in flight): `true`, or `false` after `timeoutMs`. `true` right away
 * when the note has no live saver. Never rejects.
 */
export function flushNoteSaverAndWait(key: string, timeoutMs = 5000): Promise<boolean> {
  const s = registry.get(key)?.saver;
  return s ? waitSettled([s], timeoutMs) : Promise.resolve(true);
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
  forgetKnownNoteDrafts();
  for (const e of registry.values()) {
    e.unsubscribe();
    e.saver.stop();
  }
  registry.clear();
}
