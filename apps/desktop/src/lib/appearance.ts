import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./tauri";

/** The user's choice. "system" follows macOS, live. */
export type Appearance = "system" | "light" | "dark";

export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

export const isAppearance = (v: unknown): v is Appearance => APPEARANCES.includes(v as Appearance);

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Shows `appearance`: `.dark` on <html> (the Tailwind dark variant and the dark tokens), and the
 * Tauri window theme, so the title bar matches. With "system" the window follows macOS again and
 * the class follows `prefers-color-scheme` as it changes. Returns the cleanup for the listener.
 */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): () => void {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  const paint = () => {
    const dark = appearance === "system" ? (media?.matches ?? false) : appearance === "dark";
    root.classList.toggle("dark", dark);
  };
  paint();
  // Listen before the window theme changes: un-forcing it flips the query a moment later.
  if (appearance === "system") media?.addEventListener("change", paint);
  if (isTauri()) {
    // Only the title bar depends on it: a failure (even a synchronous one) must not stop the page.
    Promise.resolve()
      .then(() => getCurrentWindow().setTheme(appearance === "system" ? null : appearance))
      .catch((e: unknown) => console.warn("could not set the window theme", e));
  }
  return () => media?.removeEventListener("change", paint);
}
