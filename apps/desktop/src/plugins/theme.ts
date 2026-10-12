/*
 * The theme a plugin frame is told: the app's scheme and a small set of its design tokens under
 * names of their own, read from the computed style of <html> at send time so they follow `.dark`
 * and any token the stylesheet changes later. The SDK puts each as `--rooms-<name>` on the
 * plugin's <html>; a name the SDK does not know is ignored there, so the two lists are checked
 * against each other in theme.test.ts.
 */

/** The plugin's name for each token, and the styles.css variable it is read from. */
export const THEME_SOURCES = {
  bg: "--pane",
  card: "--sheet",
  surface: "--surface",
  "surface-strong": "--surface-strong",
  border: "--hairline",
  "border-strong": "--hairline-strong",
  text: "--ink",
  "text-muted": "--ink-2",
  "text-faint": "--ink-3",
  accent: "--thread-deep",
  "on-accent": "--on-thread",
  error: "--error",
  success: "--success",
  radius: "--radius",
  "font-sans": "--font-sans",
  "font-serif": "--font-serif",
  shadow: "--elev-sheet",
} as const;

export type ThemeTokenName = keyof typeof THEME_SOURCES;

export interface PluginTheme {
  scheme: "light" | "dark";
  /** A token the stylesheet does not define is left out. */
  tokens: Partial<Record<ThemeTokenName, string>>;
}

/** The theme as <html> shows it now. */
export function readTheme(root: HTMLElement = document.documentElement): PluginTheme {
  const style = getComputedStyle(root);
  const tokens: PluginTheme["tokens"] = {};
  for (const [name, source] of Object.entries(THEME_SOURCES) as [ThemeTokenName, string][]) {
    const value = style.getPropertyValue(source).trim();
    if (value) tokens[name] = value;
  }
  return { scheme: root.classList.contains("dark") ? "dark" : "light", tokens };
}

/**
 * Calls `cb` with the new theme each time a change to <html>'s class list changes it (that is
 * where `applyAppearance` puts `.dark`). Returns the stop.
 */
export function watchTheme(cb: (theme: PluginTheme) => void, root: HTMLElement = document.documentElement): () => void {
  let last = JSON.stringify(readTheme(root));
  const observer = new MutationObserver(() => {
    const theme = readTheme(root);
    const key = JSON.stringify(theme);
    if (key === last) return;
    last = key;
    cb(theme);
  });
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
