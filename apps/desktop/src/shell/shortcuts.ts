/*
 * Shell shortcuts: which key maps to which action, and when an action is
 * allowed given where the focus is. Shared by the in-page key handler and the
 * native menu (Tauri), so both follow the same text-field rule.
 */

export type ShortcutAction = "toggle-sidebar" | "close-tab" | "new-tab" | "find" | "toggle-ask" | "settings";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The letter of a shortcut: `key` when it's latin, else the physical key (Korean IME gives "ㅠ" for B). */
function shortcutLetter(e: KeyboardEvent): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
}

const LETTERS: Record<string, ShortcutAction> = { b: "toggle-sidebar", w: "close-tab", t: "new-tab", k: "find", j: "toggle-ask" };

/** ⌘B / ⌘W / ⌘T / ⌘K / ⌘J / ⌘, (Ctrl off macOS), with no Shift/Alt and not mid-composition. */
export function keyAction(e: KeyboardEvent): ShortcutAction | null {
  const mod = e.metaKey || (!IS_MAC && e.ctrlKey);
  if (!mod || e.shiftKey || e.altKey || e.isComposing) return null;
  if (e.code === "Comma") return "settings";
  return LETTERS[shortcutLetter(e)] ?? null;
}

const HISTORY_CODES: Record<string, "back" | "forward"> = {
  BracketLeft: "back",
  BracketRight: "forward",
  ArrowLeft: "back",
  ArrowRight: "forward",
};

/**
 * Back and forward in the active tab, as in a browser: ⌘[ / ⌘] and ⌘← / ⌘→ (Ctrl
 * off macOS). Matched by physical key, so any layout works. Callers skip text
 * fields, where these keys indent or move the caret.
 */
export function historyKey(e: KeyboardEvent): "back" | "forward" | null {
  const mod = e.metaKey || (!IS_MAC && e.ctrlKey);
  if (!mod || e.shiftKey || e.altKey || e.isComposing) return null;
  return HISTORY_CODES[e.code] ?? null;
}

export type TabKey = { kind: "at"; index: number } | { kind: "cycle"; delta: 1 | -1 } | { kind: "reopen" };

/**
 * Switching tabs, browser style: ⌘1–⌘8 pick a tab and ⌘9 the last one; ⌘⇧] / ⌘⇧[ and
 * ⌃Tab / ⌃⇧Tab go to the next / previous tab; ⌘⇧T reopens the last closed tab (Ctrl
 * for ⌘ off macOS). Matched by physical key, so any layout and IME works.
 */
export function tabKey(e: KeyboardEvent): TabKey | null {
  if (e.altKey || e.isComposing) return null;
  if (e.code === "Tab" && e.ctrlKey && !e.metaKey) return { kind: "cycle", delta: e.shiftKey ? -1 : 1 };
  const mod = e.metaKey || (!IS_MAC && e.ctrlKey);
  if (!mod) return null;
  if (e.shiftKey) {
    if (e.code === "BracketRight") return { kind: "cycle", delta: 1 };
    if (e.code === "BracketLeft") return { kind: "cycle", delta: -1 };
    if (e.code === "KeyT") return { kind: "reopen" };
    return null;
  }
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
  if (!digit) return null;
  return { kind: "at", index: digit === "9" ? -1 : Number(digit) - 1 };
}

/** ⌘⇧[ / ⌘⇧] / ⌘⇧T: keys the native menu owns in Tauri (Window › Previous/Next Tab, File › Reopen Closed Tab). */
export const isMenuTabKey = (e: KeyboardEvent) =>
  e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight" || e.code === "KeyT");

/** ⌘[ / ⌘]: the native menu's Back/Forward accelerators (a menu item takes only one, so ⌘←/⌘→ stay with the page). */
export const isMenuHistoryKey = (e: KeyboardEvent) => e.code === "BracketLeft" || e.code === "BracketRight";

/** An input, textarea or contenteditable element: typing goes there. */
export function isTextField(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/** The note body textarea. Its saver outlives the view, so closing the tab from it is safe. */
export function isNoteEditor(el: Element | null | undefined): boolean {
  return !!el && el.tagName === "TEXTAREA" && el.hasAttribute("data-note-editor");
}

/**
 * While focus is in a text field, ⌘B/⌘T/⌘W/⌘, do nothing (they would drop a
 * rename or new-room draft), except ⌘W from the note body. ⌘K and ⌘J always work.
 */
export function allowedWithFocus(action: ShortcutAction, focused: Element | null | undefined): boolean {
  if (action === "find" || action === "toggle-ask" || !isTextField(focused)) return true;
  return action === "close-tab" && isNoteEditor(focused);
}
