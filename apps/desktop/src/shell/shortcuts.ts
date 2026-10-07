/*
 * Shell shortcuts: which key maps to which action, and when an action is
 * allowed given where the focus is. Shared by the in-page key handler and the
 * native menu (Tauri), so both follow the same text-field rule.
 */

export type ShortcutAction = "toggle-sidebar" | "close-tab" | "new-tab" | "find" | "toggle-ask";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The letter of a shortcut: `key` when it's latin, else the physical key (Korean IME gives "ㅠ" for B). */
function shortcutLetter(e: KeyboardEvent): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
}

const LETTERS: Record<string, ShortcutAction> = { b: "toggle-sidebar", w: "close-tab", t: "new-tab", k: "find", j: "toggle-ask" };

/** ⌘B / ⌘W / ⌘T / ⌘K / ⌘J (Ctrl off macOS), with no Shift/Alt and not mid-composition. */
export function keyAction(e: KeyboardEvent): ShortcutAction | null {
  const mod = e.metaKey || (!IS_MAC && e.ctrlKey);
  if (!mod || e.shiftKey || e.altKey || e.isComposing) return null;
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
 * While focus is in a text field, ⌘B/⌘T/⌘W do nothing (they would drop a
 * rename or new-room draft), except ⌘W from the note body. ⌘K and ⌘J always work.
 */
export function allowedWithFocus(action: ShortcutAction, focused: Element | null | undefined): boolean {
  if (action === "find" || action === "toggle-ask" || !isTextField(focused)) return true;
  return action === "close-tab" && isNoteEditor(focused);
}
