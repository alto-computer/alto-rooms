/*
 * Native (Tauri) app events.
 *
 * - The macOS menu's "새 탭" (⌘T), "탭 닫기" (⌘W), "찾기" (⌘K) and "사이드바"
 *   (⌘B) arrive as `menu://new-tab`, `menu://close-tab`, `menu://find` and
 *   `menu://toggle-sidebar`.
 * - `daemon://exited`: the roomsd we spawned died (App shows the core error).
 * - Before the window closes or the app quits, Rust emits `app://flush` and
 *   holds the close until we invoke `flush_done` (it gives up after 2.5s).
 *   We run the registered sync hooks, flush every note (capped at 2s), keep
 *   any note that still did not land as a draft (awaited, see drafts.ts),
 *   then answer.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { flushAllNoteSaversAndWait, keepUnsavedNoteDrafts } from "./noteSaver";

export const MENU_NEW_TAB = "menu://new-tab";
export const MENU_CLOSE_TAB = "menu://close-tab";
export const MENU_FIND = "menu://find";
export const MENU_TOGGLE_SIDEBAR = "menu://toggle-sidebar";
export const APP_FLUSH = "app://flush";
/** The roomsd this app spawned has exited. */
export const DAEMON_EXITED = "daemon://exited";
/** How long the webview waits for notes to land before letting the window close. */
export const FLUSH_CAP_MS = 2000;
/** Part of the cap kept for writing drafts of notes that did not land. */
export const DRAFT_BUDGET_MS = 400;

/** Subscribes to native events; returns a disposer that also covers listeners still registering. */
export function listenAll(handlers: Record<string, () => void>): () => void {
  let disposed = false;
  const unlisteners: UnlistenFn[] = [];
  for (const [event, fn] of Object.entries(handlers)) {
    listen(event, () => fn()).then(
      (unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      },
      (err) => console.error(`could not listen for ${event}:`, err),
    );
  }
  return () => {
    disposed = true;
    for (const u of unlisteners.splice(0)) u();
  };
}

const beforeFlush = new Set<() => void>();

/** Registers a synchronous step to run first on `app://flush` (e.g. recording the last visit). */
export function onBeforeQuitFlush(fn: () => void): () => void {
  beforeFlush.add(fn);
  return () => {
    beforeFlush.delete(fn);
  };
}

/** Runs the hooks, flushes notes (≤ `cap` ms), then tells Rust it may close. Never throws. */
export async function runQuitFlush(cap = FLUSH_CAP_MS, done: () => Promise<unknown> = () => invoke("flush_done")): Promise<void> {
  for (const fn of beforeFlush) {
    try {
      fn();
    } catch (err) {
      console.error("quit flush step failed:", err);
    }
  }
  // Notes get most of the cap; the rest is for writing drafts of whatever did not land.
  const landed = await flushAllNoteSaversAndWait(Math.max(0, cap - DRAFT_BUDGET_MS));
  if (!landed) {
    // Awaited, so the drafts are on disk before Rust is told it may exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((r) => (timer = setTimeout(r, DRAFT_BUDGET_MS)));
    await Promise.race([keepUnsavedNoteDrafts(), budget]);
    clearTimeout(timer);
  }
  try {
    await done();
  } catch (err) {
    console.error("flush_done failed:", err);
  }
}

/** Answers `app://flush` for the life of the page. */
export function installQuitFlushResponder(): () => void {
  return listenAll({ [APP_FLUSH]: () => void runQuitFlush() });
}
