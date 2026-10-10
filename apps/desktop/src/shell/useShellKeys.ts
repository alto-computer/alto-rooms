import { useEffect } from "react";
import type { ViewerStore } from "@/data/viewerStore";
import {
  listenAll,
  MENU_BACK,
  MENU_CLOSE_TAB,
  MENU_FIND,
  MENU_FORWARD,
  MENU_NEW_TAB,
  MENU_NEXT_TAB,
  MENU_PREV_TAB,
  MENU_REOPEN_TAB,
  MENU_SETTINGS,
  MENU_TOGGLE_ASK,
  MENU_TOGGLE_SIDEBAR,
} from "@/lib/appEvents";
import { openSettings } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";
import { allowedWithFocus, historyKey, isMenuHistoryKey, isMenuTabKey, isTextField, keyAction, tabKey, type ShortcutAction, type TabKey } from "./shortcuts";

/** Every keyboard, mouse-button and native-menu binding of the shell. */
export function useShellKeys(viewer: ViewerStore, openFind: () => void, toggleAsk: () => void) {
  useShortcuts(viewer, openFind, toggleAsk);
  useHistoryNav(viewer);
  useTabKeys(viewer);
}

/** Runs a shell action (callers check the focus rule first). */
function runAction(action: ShortcutAction, viewer: ViewerStore, openFind: () => void, toggleAsk: () => void) {
  const s = viewer.getState();
  switch (action) {
    case "toggle-sidebar":
      viewer.setSidebarOpen(!s.sidebarOpen);
      break;
    case "close-tab":
      if (s.activeId) viewer.close(s.activeId);
      break;
    case "new-tab":
      viewer.open(viewer.home());
      break;
    case "find":
      openFind();
      break;
    case "toggle-ask":
      toggleAsk();
      break;
    case "settings":
      openSettings(viewer);
      break;
  }
}

/**
 * ⌘B sidebar, ⌘W close tab, ⌘T new tab (home: today's Journal), ⌘K quick find, ⌘J ask bar, ⌘, Settings.
 * Bound on window. In Tauri all six belong to the native menu (which emits `menu://…`), so the
 * page leaves them alone and they never fire twice. Either way the same focus
 * rule applies: ⌘K and ⌘J work from a text field, the others don't (except ⌘W from
 * the note body).
 */
function useShortcuts(viewer: ViewerStore, openFind: () => void, toggleAsk: () => void) {
  useEffect(() => {
    const menuOwned = isTauri();
    const onKey = (e: KeyboardEvent) => {
      const action = keyAction(e);
      if (!action) return;
      if (menuOwned) return;
      if (!allowedWithFocus(action, e.target instanceof Element ? e.target : null)) return;
      e.preventDefault();
      runAction(action, viewer, openFind, toggleAsk);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, openFind, toggleAsk]);

  useEffect(() => {
    if (!isTauri()) return;
    const fromMenu = (action: ShortcutAction) => () => {
      if (allowedWithFocus(action, document.activeElement)) runAction(action, viewer, openFind, toggleAsk);
    };
    return listenAll({
      [MENU_NEW_TAB]: fromMenu("new-tab"),
      [MENU_CLOSE_TAB]: fromMenu("close-tab"),
      [MENU_FIND]: fromMenu("find"),
      [MENU_TOGGLE_SIDEBAR]: fromMenu("toggle-sidebar"),
      [MENU_TOGGLE_ASK]: fromMenu("toggle-ask"),
      [MENU_SETTINGS]: fromMenu("settings"),
    });
  }, [viewer, openFind, toggleAsk]);
}

/**
 * Back/forward in the active tab: ⌘[ / ⌘] and ⌘← / ⌘→ (not from a text field, where
 * they indent or move the caret) and the mouse's back/forward buttons (3/4). In
 * Tauri the native menu (View › Back/Forward) owns ⌘[ / ⌘], as with the other shortcuts.
 */
function useHistoryNav(viewer: ViewerStore) {
  useEffect(() => {
    const menuOwned = isTauri();
    const go = (dir: "back" | "forward") => (dir === "back" ? viewer.back() : viewer.forward());
    const unlisten = menuOwned
      ? listenAll({
          [MENU_BACK]: () => !isTextField(document.activeElement) && go("back"),
          [MENU_FORWARD]: () => !isTextField(document.activeElement) && go("forward"),
        })
      : null;
    const onKey = (e: KeyboardEvent) => {
      if (menuOwned && isMenuHistoryKey(e)) return;
      const dir = historyKey(e);
      if (!dir || isTextField(e.target instanceof Element ? e.target : null)) return;
      e.preventDefault();
      go(dir);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) viewer.back();
      else viewer.forward();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [viewer]);
}

function runTabKey(k: TabKey, viewer: ViewerStore) {
  if (k.kind === "at") viewer.activateAt(k.index);
  else if (k.kind === "cycle") viewer.cycle(k.delta);
  else viewer.reopen();
}

/**
 * Tab switching (see `tabKey`); works from text fields too, as in a browser. In Tauri the
 * native menu owns ⌘⇧[ / ⌘⇧] / ⌘⇧T; ⌘1–9 and ⌃Tab stay with the page.
 */
function useTabKeys(viewer: ViewerStore) {
  useEffect(() => {
    const menuOwned = isTauri();
    const unlisten = menuOwned
      ? listenAll({
          [MENU_NEXT_TAB]: () => viewer.cycle(1),
          [MENU_PREV_TAB]: () => viewer.cycle(-1),
          [MENU_REOPEN_TAB]: () => viewer.reopen(),
        })
      : null;
    const onKey = (e: KeyboardEvent) => {
      if (menuOwned && isMenuTabKey(e)) return;
      const k = tabKey(e);
      if (!k) return;
      e.preventDefault();
      // Let a field being edited (a rename) save on blur before its view goes away.
      if (isTextField(document.activeElement)) (document.activeElement as HTMLElement).blur();
      runTabKey(k, viewer);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [viewer]);
}
