/*
 * The app's theme in a plugin page. The app sends `{ rooms: 1, type: "theme", scheme, tokens }`
 * once the page connects and again whenever its appearance changes. The SDK puts each token on
 * <html> as `--rooms-<name>`, sets `color-scheme` to the scheme (in Chromium, an iframe whose
 * document's scheme differs from the app's paints an opaque white canvas), and, unless the plugin
 * opts out, gives the page the app's pane colour and ink through a rule of zero specificity, so any
 * rule of the plugin's own wins. Only the names below are applied, and only values that read as
 * plain CSS. One page has one theme state, shared by `connect()` and `connectSurfaces()`: an opt-out
 * from either holds for both, and `ready` and `hello` tell the app whether the page applies the
 * theme, so the app can give the frame the pane colour only then.
 */

export type ThemeScheme = "light" | "dark";

/** The tokens the app may send, each applied as `--rooms-<name>`. */
export const THEME_TOKENS = [
  "bg",
  "card",
  "surface",
  "surface-strong",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "text-faint",
  "accent",
  "on-accent",
  "error",
  "success",
  "radius",
  "font-sans",
  "font-serif",
  "shadow",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface RoomsTheme {
  scheme: ThemeScheme;
  /** A token the app's stylesheet does not define is left out. */
  tokens: Partial<Record<ThemeToken, string>>;
}

export interface RoomsThemeApi {
  /** The theme last heard, or null before the app sent one. */
  current(): RoomsTheme | null;
  /** Called at once when a theme is known, then on every change. Returns an unsubscribe. */
  onChange(cb: (theme: RoomsTheme) => void): () => void;
}

const STYLE_ID = "rooms-theme";
const DEFAULT_RULE = ":where(html){background:var(--rooms-bg);color:var(--rooms-text)}";

/** A colour, length, font list or shadow as computed style spells it, in any script: no braces, semicolons, escapes or URLs. */
const VALUE = /^[\p{L}\p{M}\p{N}_\s#%.,()/"'*+-]{1,512}$/u;
const isValue = (v: unknown): v is string => typeof v === "string" && VALUE.test(v) && !/url\s*\(/i.test(v);
const isToken = (k: string): k is ThemeToken => (THEME_TOKENS as readonly string[]).includes(k);

/** The theme in a message from the app, or null when the message is not one. Tokens it does not know, or cannot read as a value, are dropped. */
export function parseTheme(data: unknown): RoomsTheme | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { rooms?: unknown; type?: unknown; scheme?: unknown; tokens?: unknown };
  if (d.rooms !== 1 || d.type !== "theme") return null;
  if (d.scheme !== "light" && d.scheme !== "dark") return null;
  const tokens: RoomsTheme["tokens"] = {};
  if (d.tokens && typeof d.tokens === "object") {
    for (const [k, v] of Object.entries(d.tokens)) if (isToken(k) && isValue(v)) tokens[k] = v;
  }
  return { scheme: d.scheme, tokens };
}

/** Puts the theme on `page`: the variables, `color-scheme`, `data-rooms-scheme`, and the default page colours. */
export function applyTheme(theme: RoomsTheme, page: Document = document): void {
  const root = page.documentElement;
  for (const name of THEME_TOKENS) {
    const value = theme.tokens[name];
    if (value === undefined) root.style.removeProperty(`--rooms-${name}`);
    else root.style.setProperty(`--rooms-${name}`, value);
  }
  root.style.setProperty("color-scheme", theme.scheme);
  root.dataset.roomsScheme = theme.scheme;
  if (page.getElementById(STYLE_ID)) return;
  const style = page.createElement("style");
  style.id = STYLE_ID;
  style.textContent = DEFAULT_RULE;
  page.head.append(style);
}

export interface PageTheme {
  api: RoomsThemeApi;
  /** Whether the SDK puts the theme on this page: false once any connection on it opted out. */
  readonly applies: boolean;
}

let shared: (PageTheme & { optOut(): void; stop(): void }) | null = null;

/**
 * The page's one theme state, started on first use: it hears every theme message from the app,
 * keeps the last one, and, while nothing opted out, puts it on the page. With `apply` false this
 * connection opts the page out.
 */
export function pageTheme(apply: boolean): PageTheme {
  shared ??= startPageTheme();
  if (!apply) shared.optOut();
  return shared;
}

/** Forgets the page's theme state and stops hearing the app. For tests. */
export function resetPageTheme(): void {
  shared?.stop();
  shared = null;
}

function startPageTheme() {
  let current: RoomsTheme | null = null;
  let applies = true;
  const listeners = new Set<(t: RoomsTheme) => void>();
  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const theme = parseTheme(e.data);
    if (!theme) return;
    current = theme;
    if (applies) applyTheme(theme);
    for (const l of [...listeners]) l(theme);
  };
  window.addEventListener("message", onMessage);
  return {
    api: {
      current: () => current,
      onChange(cb: (t: RoomsTheme) => void) {
        listeners.add(cb);
        if (current) cb(current);
        return () => void listeners.delete(cb);
      },
    },
    get applies() {
      return applies;
    },
    optOut() {
      applies = false;
    },
    stop() {
      window.removeEventListener("message", onMessage);
    },
  };
}
