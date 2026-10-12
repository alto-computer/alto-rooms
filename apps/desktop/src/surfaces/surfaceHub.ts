/*
 * Host text surfaces: the text the app shows that plugins may read and mark. A surface
 * (today a finished chat answer) registers its element and text index here; every plugin with
 * `surfaces.text` gets the text in its hidden background frame and answers with ranges to paint
 * and buttons for the selection bar. Core paints with the CSS Custom Highlight API and never
 * touches the surface's DOM. Everything from a frame is untrusted: shapes, sizes, offsets, style
 * names and colors are checked here, and a surface's ranges die with the surface.
 *
 * A frame built on SDK 0.6 or later says `hello` when it connects and puts `api: 2` on every
 * message; it hears artifact and session scopes by those names. A frame that never does is on SDK
 * 0.5 and hears them as `doc` and as `conversation` with the id in `session`, the shapes its
 * `surfacePath` reads.
 *
 * Each plugin's `::highlight` rules live in a constructed stylesheet of its own, written one rule
 * at a time, so nothing a plugin declares can reach another plugin's rules. A constructed sheet
 * is CSSOM, not an inline style: the desktop app's CSP carries Tauri's nonce in `style-src`,
 * which makes the browser ignore `'unsafe-inline'` and drop any `<style>` element made at runtime.
 */
import type { AskScope } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { isAgent, isSessionId } from "@/lib/agents";
import { isNoteName, noteKey } from "@/lib/notes";
import { isColor, parseActions, type ContentAction } from "@/plugins/contentChannel";
import { buildIndex, offsetOf, rangeAt, type TextIndex } from "./surfaceIndex";

/** A finished chat answer, or a note's body; `name` is the note's on-disk file name, `.md` included. */
export type SurfaceId = { kind: "answer"; scope: AskScope; turnId: string } | { kind: "note"; date: string; name: string };

/** `answer:<scopeKey>/<turnId>` or `note:<date>/<folded file name>`: the one name a surface has while open. */
export const surfaceKey = (s: SurfaceId): string => (s.kind === "answer" ? `answer:${scopeKey(s.scope)}/${s.turnId}` : `note:${noteKey(s.date, s.name)}`);

const FLASH = "rooms-flash";

/** Ranges one `paint` may carry for one surface. */
export const MAX_RANGES = 1000;
/** Styles one plugin may declare over its lifetime; each is one `::highlight` rule. */
export const MAX_STYLES = 16;
const MAX_COLOR_LENGTH = 64;
const REVEAL_WAIT_MS = 10_000;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A style name goes into a `::highlight()` selector as is, so it is a plain lowercase identifier. */
const STYLE = /^[a-z][a-z0-9-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SurfaceRange = { id: string; start: number; end: number; style: string };
/** Where a selection lies: inside one open surface, as offsets into its text, with that slice of it. */
export type SurfaceSpan = { key: string; start: number; end: number; text: string };
export type SurfaceAction = ContentAction & { plugin: string };
export type SurfaceMenu = { plugin: string; key: string; rangeId: string; range: Range; items: ContentAction[] };
export type SurfaceReveal = { id: SurfaceId; rangeId: string };

export type SurfaceSnapshot = {
  /** Every plugin's declared buttons, in plugin id order. */
  actions: SurfaceAction[];
  /** A menu a plugin answered a range click with. */
  menu: SurfaceMenu | null;
  /** An `open({ surface, rangeId })` on its way to a surface that is not open yet. */
  reveal: SurfaceReveal | null;
};

type HostMessage =
  | { type: "surface.open"; surface: SurfaceId; text: string; version: number }
  | { type: "surface.close"; surface: SurfaceId }
  | { type: "selection.action"; surface: SurfaceId; actionId: string; start: number; end: number; text: string }
  | { type: "range.click"; surface: SurfaceId; rangeId: string }
  | { type: "range.action"; surface: SurfaceId; rangeId: string; actionId: string };

/** A plugin's style names and the color each paints with. */
type Styles = Map<string, string>;

type FrameMessage =
  | { type: "hello" }
  | { type: "ready" }
  | { type: "actions"; items: ContentAction[] }
  /** Ranges as offsets into the text the plugin last heard (`OpenSurface.told`), not the text on screen. */
  | { type: "paint"; key: string; styles: Styles; ranges: SurfaceRange[]; dropped: number }
  /** A paint against a text older than the one last told; the plugin heard the newer one and paints again. */
  | { type: "stale" }
  | { type: "menu"; key: string; rangeId: string; items: ContentAction[] };

export type OpenOptions = {
  /**
   * How long the text must stay still before plugins hear a change. 0 tells them at once; a note
   * passes 300, so a run of keystrokes is one message. The paint keeps up either way: core moves
   * it through each edit itself.
   */
  quietMs?: number;
  /** Brings a range into view for a flash. The default scrolls the element holding its first text node. */
  reveal?: (range: Range) => void;
};

type OpenSurface = OpenOptions & {
  id: SurfaceId;
  key: string;
  root: HTMLElement;
  index: TextIndex;
  /** The text plugins last heard for this surface, null before the first `surface.open`. */
  told: string | null;
  /** The hub-wide number of the text last told for this surface (0 before the first); a paint names the one it was read against. */
  version: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/** One replacement that turns `before` into `after`: `[start, end)` of `before` became `inserted` characters. */
export type TextEdit = { start: number; end: number; inserted: number };

/** The edit between two texts, read off their common prefix and suffix; a typed keystroke is one. */
export function editBetween(before: string, after: string): TextEdit {
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let suffix = 0;
  while (suffix < shortest - start && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  return { start, end: before.length - suffix, inserted: after.length - suffix - start };
}

/**
 * `ranges` as they lie after `edit`: one before it stays, one after it moves by the edit's growth,
 * and one the edit cut into is gone, since its plugin re-anchors from the quote once it hears the
 * text. Typing at a range's edge counts as outside it, so a word stays painted while the user
 * types up to and away from it.
 */
export function shiftRanges(ranges: readonly SurfaceRange[], edit: TextEdit): SurfaceRange[] {
  const delta = edit.inserted - (edit.end - edit.start);
  const out: SurfaceRange[] = [];
  for (const r of ranges) {
    if (r.end <= edit.start) out.push(r);
    else if (r.start >= edit.end) out.push({ ...r, start: r.start + delta, end: r.end + delta });
  }
  return out;
}
/** A range in one of a plugin's highlights, and the style it is under. */
type Drawn = { range: Range; style: string };

type Seat = {
  id: string;
  /** The surface shapes the plugin's SDK reads: 1 until it says `api: 2` (SDK 0.6). */
  api: 1 | 2;
  post: (m: HostMessage) => void;
  actions: ContentAction[];
  styles: Styles;
  paints: Map<string, SurfaceRange[]>;
  /** The live ranges this plugin's highlights hold, per surface, so one surface repaints without the others. */
  drawn: Map<string, Drawn[]>;
  /** This plugin's `::highlight` rules, one per style; null without a DOM. */
  sheet: CSSStyleSheet | null;
  /**
   * `Date.now()` of the last click the user gave this plugin: a selection-bar button or a menu
   * item. A click on a painted range is not one: a plugin could paint transparent ranges over a
   * whole answer and call any click its own.
   */
  gestureAt: number | null;
};

/** The functions a paint color may use: the color ones, never a substitution such as `var()`, `env()` or `attr()`. */
const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"]);
/** Hex, names, numbers, percentages and the color functions' punctuation: no braces, semicolons, quotes, comments or escapes. */
const COLOR_CHARS = /^[A-Za-z0-9#(),.%/+\- ]+$/;

/**
 * A color the browser accepts that is safe to write into a rule as is. `CSS.supports("color", v)`
 * admits `var(--x, {`, `env(--x, (` and escaped spellings of them, since substitution is checked
 * at computed-value time: such a value would carry a `{` into the stylesheet or read a host token.
 */
export function isPaintColor(v: string): boolean {
  if (v.length > MAX_COLOR_LENGTH || !COLOR_CHARS.test(v)) return false;
  let depth = 0;
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  for (const [, fn] of v.matchAll(/([A-Za-z-]+)\(/g)) if (!COLOR_FUNCTIONS.has(fn.toLowerCase())) return false;
  return isColor(v);
}

/** A constructed sheet the document adopts, or null without a DOM. */
function adoptSheet(): CSSStyleSheet | null {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return null;
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return sheet;
}

function dropSheet(sheet: CSSStyleSheet | null): void {
  if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
}

/**
 * `id` as SDK 0.5 names it, for a plugin that never said it reads API 2. A note goes as it is:
 * 0.5 had no note kind, and its docs told plugins that `surface.kind` would tell notes apart.
 */
function surfaceForApi1(id: SurfaceId): unknown {
  if (id.kind !== "answer") return id;
  const { scope } = id;
  if (scope.kind === "artifact") return { ...id, scope: { kind: "doc", fileKey: scope.fileKey } };
  if (scope.kind === "session") return { ...id, scope: { kind: "conversation", agent: scope.agent, session: scope.id } };
  return id;
}

/**
 * The surface a plugin named, as JSON from its frame, or null. Until SDK 0.7 a plugin may still
 * name a scope the 0.5 way (`doc`, and `conversation` with the id in `session`), as surfaces it
 * saved then do; those come back under the new names.
 */
export function parseSurfaceId(v: unknown): SurfaceId | null {
  if (!v || typeof v !== "object") return null;
  const { kind, scope, turnId, date, name } = v as Record<string, unknown>;
  if (kind === "note") {
    return typeof date === "string" && DATE.test(date) && typeof name === "string" && isNoteName(name) ? { kind: "note", date, name } : null;
  }
  if (kind !== "answer" || typeof turnId !== "string" || !ID.test(turnId) || !scope || typeof scope !== "object") return null;
  const s = scope as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;
  const answer = (scope: AskScope): SurfaceId => ({ kind: "answer", scope, turnId });
  if ((s.kind === "artifact" || s.kind === "doc") && str(s.fileKey)) return answer({ kind: "artifact", fileKey: s.fileKey });
  if (s.kind === "room" && str(s.roomId)) return answer({ kind: "room", roomId: s.roomId });
  if (s.kind === "day" && typeof s.date === "string" && DATE.test(s.date)) return answer({ kind: "day", date: s.date });
  const id = s.kind === "session" ? s.id : s.kind === "conversation" ? s.session : undefined;
  if (isAgent(s.agent) && isSessionId(id)) return answer({ kind: "session", agent: s.agent, id });
  return null;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * `known` plus the styles a paint declares, or null when a name is not an identifier, a color is
 * not a paint color, or the plugin would hold more than MAX_STYLES. A declared name replaces its
 * earlier color.
 */
function parseStyles(v: unknown, known: Styles): Styles | null {
  if (v === undefined) return known;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const styles = new Map(known);
  for (const [name, color] of Object.entries(v as Record<string, unknown>)) {
    if (!STYLE.test(name) || typeof color !== "string" || !isPaintColor(color)) return null;
    styles.set(name, color);
  }
  return styles.size <= MAX_STYLES ? styles : null;
}

/** Ranges inside `length` with a declared style and a short id; others are counted, not kept. */
function parseRanges(v: unknown, length: number, styles: Styles): { ranges: SurfaceRange[]; dropped: number } | null {
  if (!Array.isArray(v) || v.length > MAX_RANGES) return null;
  const ranges: SurfaceRange[] = [];
  let dropped = 0;
  for (const it of v as unknown[]) {
    const { id, start, end, style } = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const ok =
      typeof id === "string" && ID.test(id) && !ranges.some((r) => r.id === id) && isInt(start) && isInt(end) && start >= 0 && start < end && end <= length && typeof style === "string" && styles.has(style);
    if (ok) ranges.push({ id, start, end, style: style as string });
    else dropped++;
  }
  return { ranges, dropped };
}

function parseFrameMessage(data: unknown, surfaces: ReadonlyMap<string, OpenSurface>, known: Styles): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.rooms !== "surface" || d.v !== 1) return null;
  if (d.type === "hello") return { type: "hello" };
  if (d.type === "ready") return { type: "ready" };
  if (d.type === "actions") {
    const items = parseActions(d.items, isColor);
    return items ? { type: "actions", items } : null;
  }
  const id = parseSurfaceId(d.surface);
  const open = id && surfaces.get(surfaceKey(id));
  if (!open) return null;
  if (d.type === "paint") {
    if (d.version !== undefined && d.version !== open.version) return isInt(d.version) ? { type: "stale" } : null;
    const styles = parseStyles(d.styles, known);
    const parsed = styles && parseRanges(d.ranges, (open.told ?? open.index.text).length, styles);
    return styles && parsed ? { type: "paint", key: open.key, styles, ...parsed } : null;
  }
  if (d.type === "menu" && typeof d.rangeId === "string" && ID.test(d.rangeId)) {
    const items = parseActions(d.items, isColor);
    return items ? { type: "menu", key: open.key, rangeId: d.rangeId, items } : null;
  }
  return null;
}

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;

const highlightName = (plugin: string, style: string) => `rooms-${plugin}-${style}`;

/** The highlight `plugin` paints `style` into, registered on first use. */
function highlightFor(reg: HighlightRegistry, plugin: string, style: string): Highlight {
  const name = highlightName(plugin, style);
  let h = reg.get(name);
  if (!h) {
    h = new Highlight();
    reg.set(name, h);
  }
  return h;
}

/** The caret at a point, in whichever form the engine offers. */
function caretAt(dom: Document, x: number, y: number): { node: Node; offset: number } | null {
  if (typeof dom.caretPositionFromPoint === "function") {
    const p = dom.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = dom.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

export class SurfaceHub {
  private surfaces = new Map<string, OpenSurface>();
  private seats = new Map<string, Seat>();
  private listeners = new Set<() => void>();
  private snapshot: SurfaceSnapshot = { actions: [], menu: null, reveal: null };
  /** The flash rule, in a sheet of its own like each plugin's; made on the first flash. */
  private flashSheet: CSSStyleSheet | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  /** Texts told so far, over every surface: a surface that closes and opens again never repeats a number, so a paint from its earlier life cannot match. */
  private versions = 0;
  /** Messages from a frame that were malformed, named a closed surface, or carried ranges outside the text. */
  dropped = 0;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = (): SurfaceSnapshot => this.snapshot;

  /**
   * A surface's element and text are on screen: every background frame hears `surface.open`, at
   * once or after `quietMs` of still text. The same text in new nodes (React swapped them)
   * re-anchors the paint and tells no plugin; changed text moves the paint through the edit now,
   * and the plugins re-anchor from their quotes when they hear it. Either way a menu over the
   * surface pointed into the old nodes and closes.
   */
  open(id: SurfaceId, root: HTMLElement, opts: OpenOptions = {}): void {
    const key = surfaceKey(id);
    const index = buildIndex(root);
    const was = this.surfaces.get(key);
    const s: OpenSurface = { ...opts, id, key, root, index, told: was?.told ?? null, version: was?.version ?? 0, timer: was?.timer ?? null };
    this.surfaces.set(key, s);
    if (this.snapshot.menu?.key === key) this.set({ menu: null });
    if (was && was.index.text !== index.text) {
      const edit = editBetween(was.index.text, index.text);
      for (const seat of this.seats.values()) {
        const ranges = seat.paints.get(key);
        if (ranges) seat.paints.set(key, shiftRanges(ranges, edit));
      }
    }
    if (was) for (const seat of this.seats.values()) this.repaint(seat, key);
    this.tell(s);
  }

  /**
   * Plugins hear `s`'s text once it differs from what they last heard: the first text now, a
   * change after the quiet time, or now when `now` (a click over the text needs them on it).
   */
  private tell(s: OpenSurface, now = false): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (s.told === s.index.text) return;
    const post = () => {
      s.timer = null;
      s.told = s.index.text;
      s.version = ++this.versions;
      for (const seat of this.seats.values()) seat.post({ type: "surface.open", surface: s.id, text: s.told, version: s.version });
    };
    if (!now && s.quietMs && s.told !== null) s.timer = setTimeout(post, s.quietMs);
    else post();
  }

  close(key: string): void {
    const s = this.surfaces.get(key);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.surfaces.delete(key);
    for (const seat of this.seats.values()) {
      seat.paints.delete(key);
      this.repaint(seat, key);
      seat.post({ type: "surface.close", surface: s.id });
    }
    if (this.snapshot.menu?.key === key) this.set({ menu: null });
  }

  /** `text.slice(start, end)` of open surface `key` as a span for a button, with its DOM range for placing the bar; null outside the text. */
  span(key: string, start: number, end: number): (SurfaceSpan & { range: Range }) | null {
    const s = this.surfaces.get(key);
    const range = s && rangeAt(s.index, start, end);
    return s && range ? { key, start, end, text: s.index.text.slice(start, end), range } : null;
  }

  /**
   * Where a DOM range lies: the one open surface it touches, clamped to it, since a triple-click
   * ends in the next block and a drag may start before the answer. A range that touches two
   * surfaces, even one it only crosses, is nowhere.
   */
  locate = (range: Range): SurfaceSpan | null => {
    const touched = [...this.surfaces.values()].filter((s) => range.intersectsNode(s.root));
    if (touched.length !== 1) return null;
    const [s] = touched;
    const start = s.root.contains(range.startContainer) ? offsetOf(s.index, range.startContainer, range.startOffset) : 0;
    const end = s.root.contains(range.endContainer) ? offsetOf(s.index, range.endContainer, range.endOffset) : s.index.text.length;
    return end > start ? { key: s.key, start, end, text: s.index.text.slice(start, end) } : null;
  };

  /** One plugin's background frame: `receive` takes its messages, `dispose` forgets its paint and buttons. */
  register(plugin: string, post: (m: Record<string, unknown>) => void): { receive(data: unknown): void; dispose(): void } {
    if (!/^[a-z0-9-]{2,40}$/.test(plugin)) throw new Error(`not a plugin id: ${plugin}`);
    const seat: Seat = {
      id: plugin,
      api: 1,
      post: (m) => post({ rooms: "surface", v: 1, ...m, surface: seat.api === 2 ? m.surface : surfaceForApi1(m.surface) }),
      actions: [],
      styles: new Map(),
      paints: new Map(),
      drawn: new Map(),
      sheet: adoptSheet(),
      gestureAt: null,
    };
    this.seats.set(plugin, seat);
    return {
      receive: (data) => {
        if (!data || typeof data !== "object" || (data as { rooms?: unknown }).rooms !== "surface") return;
        const { api } = data as { api?: unknown };
        if (isInt(api) && api >= 2) seat.api = 2;
        const m = parseFrameMessage(data, this.surfaces, seat.styles);
        if (!m) {
          this.dropped++;
          return;
        }
        switch (m.type) {
          case "hello":
            return;
          case "ready":
            for (const s of this.surfaces.values()) seat.post({ type: "surface.open", surface: s.id, text: s.told ?? s.index.text, version: s.version });
            return;
          case "stale":
            return;
          case "actions":
            seat.actions = m.items;
            this.set({ actions: this.allActions() });
            return;
          case "paint": {
            this.dropped += m.dropped;
            if (m.styles !== seat.styles) {
              seat.styles = m.styles;
              this.restyle(seat);
            }
            // Read against the text the plugin heard; keystrokes since then move it, as they move every paint.
            const s = this.surfaces.get(m.key)!;
            seat.paints.set(m.key, s.told !== null && s.told !== s.index.text ? shiftRanges(m.ranges, editBetween(s.told, s.index.text)) : m.ranges);
            this.repaint(seat, m.key);
            const r = this.snapshot.reveal;
            if (r && surfaceKey(r.id) === m.key && m.ranges.some((x) => x.id === r.rangeId)) {
              this.set({ reveal: null });
              this.flash(m.key, r.rangeId);
            }
            return;
          }
          case "menu": {
            const range = this.rangeOf(seat, m.key, m.rangeId);
            if (!range) {
              this.dropped++;
              return;
            }
            this.set({ menu: { plugin, key: m.key, rangeId: m.rangeId, range, items: m.items } });
          }
        }
      },
      dispose: () => {
        if (this.seats.get(plugin) !== seat) return;
        this.seats.delete(plugin);
        const reg = registry();
        for (const style of seat.styles.keys()) reg?.delete(highlightName(plugin, style));
        dropSheet(seat.sheet);
        this.set({ actions: this.allActions(), menu: this.snapshot.menu?.plugin === plugin ? null : this.snapshot.menu });
      },
    };
  }

  /**
   * A button of `plugin` was clicked over `span`: the plugin hears where and what, in the text on
   * screen, which it hears first if a quiet time still held it. A span whose text is no longer at
   * its offsets (the text changed under a bar) is not a click.
   */
  runAction(plugin: string, actionId: string, span: SurfaceSpan): void {
    const seat = this.seats.get(plugin);
    const s = this.surfaces.get(span.key);
    if (!seat || !s || !seat.actions.some((a) => a.id === actionId) || s.index.text.slice(span.start, span.end) !== span.text) return;
    this.tell(s, true);
    seat.gestureAt = Date.now();
    seat.post({ type: "selection.action", surface: s.id, actionId, start: span.start, end: span.end, text: span.text });
  }

  /** When the user last clicked one of `plugin`'s buttons or menu items, or null. A range click does not count. */
  lastGesture(plugin: string): number | null {
    return this.seats.get(plugin)?.gestureAt ?? null;
  }

  /**
   * A click at a point in surface `key`: the plugin whose painted range is under it hears
   * `range.click`. True when one was. It grants nothing; the plugin answers with a menu, and a
   * pick from that is the gesture.
   */
  click(key: string, x: number, y: number): boolean {
    const s = this.surfaces.get(key);
    if (!s) return false;
    const caret = caretAt(s.root.ownerDocument, x, y);
    if (!caret || !s.root.contains(caret.node)) return false;
    return this.clickAt(key, offsetOf(s.index, caret.node, caret.offset));
  }

  /** `click` for a surface whose caret the browser reports as an offset, as a textarea does. */
  clickAt(key: string, at: number): boolean {
    const s = this.surfaces.get(key);
    if (!s) return false;
    let hit: { seat: Seat; range: SurfaceRange } | null = null;
    for (const seat of this.seats.values()) {
      for (const range of seat.paints.get(key) ?? []) if (range.start <= at && at < range.end) hit = { seat, range };
    }
    if (!hit) return false;
    hit.seat.post({ type: "range.click", surface: s.id, rangeId: hit.range.id });
    return true;
  }

  runMenu(actionId: string): void {
    const m = this.snapshot.menu;
    const s = m && this.surfaces.get(m.key);
    this.set({ menu: null });
    if (!m || !s || !m.items.some((a) => a.id === actionId)) return;
    const seat = this.seats.get(m.plugin);
    if (!seat) return;
    seat.gestureAt = Date.now();
    seat.post({ type: "range.action", surface: s.id, rangeId: m.rangeId, actionId });
  }

  closeMenu(): void {
    if (this.snapshot.menu) this.set({ menu: null });
  }

  /**
   * Brings a range into view and flashes it: now when its surface is open and painted, else once a
   * paint carries it. The plugin paints after an async read, so an open surface may not hold the
   * range yet. A reveal nobody paints within 10 s is forgotten.
   */
  reveal(id: SurfaceId, rangeId: string): void {
    const key = surfaceKey(id);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    for (const seat of this.seats.values()) {
      if (seat.paints.get(key)?.some((r) => r.id === rangeId)) {
        this.set({ reveal: null });
        this.flash(key, rangeId);
        return;
      }
    }
    this.set({ reveal: { id, rangeId } });
    this.revealTimer = setTimeout(() => {
      if (this.snapshot.reveal?.rangeId === rangeId && surfaceKey(this.snapshot.reveal.id) === key) this.set({ reveal: null });
    }, REVEAL_WAIT_MS);
  }

  private flash(key: string, rangeId: string): void {
    const s = this.surfaces.get(key);
    if (!s) return;
    let range: Range | null = null;
    for (const seat of this.seats.values()) range ??= this.rangeOf(seat, key, rangeId);
    // The element holding the range's first text node: a long answer's top may be a screen away from it.
    if (range && s.reveal) s.reveal(range);
    else (range?.startContainer.parentElement ?? s.root).scrollIntoView({ block: "center" });
    const reg = registry();
    if (!reg || !range) return;
    if (!this.flashSheet) {
      this.flashSheet = adoptSheet();
      this.flashSheet?.insertRule(`::highlight(${FLASH}) { background-color: var(--thread-soft); }`);
    }
    reg.set(FLASH, new Highlight(range));
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => reg.delete(FLASH), 1200);
  }

  private rangeOf(seat: Seat, key: string, rangeId: string): Range | null {
    const s = this.surfaces.get(key);
    const r = seat.paints.get(key)?.find((x) => x.id === rangeId);
    return s && r ? rangeAt(s.index, r.start, r.end) : null;
  }

  private allActions(): SurfaceAction[] {
    return [...this.seats.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).flatMap((seat) => seat.actions.map((a) => ({ plugin: seat.id, ...a })));
  }

  /**
   * Redraws `seat`'s paint on surface `key` from its offsets: the ranges it drew there leave the
   * highlights and new ones go in, while every other surface's ranges stay as they are. A
   * keystroke in a note costs its own ranges, not every open answer's.
   */
  private repaint(seat: Seat, key: string): void {
    const reg = registry();
    if (!reg) return;
    for (const d of seat.drawn.get(key) ?? []) reg.get(highlightName(seat.id, d.style))?.delete(d.range);
    const s = this.surfaces.get(key);
    const drawn: Drawn[] = [];
    for (const r of (s && seat.paints.get(key)) ?? []) {
      const range = s && rangeAt(s.index, r.start, r.end);
      if (!range) continue;
      highlightFor(reg, seat.id, r.style).add(range);
      drawn.push({ range, style: r.style });
    }
    if (drawn.length) seat.drawn.set(key, drawn);
    else seat.drawn.delete(key);
  }

  /**
   * Rewrites `seat`'s sheet: one rule per style, each inserted on its own, so a rule the engine
   * rejects is the only one lost. The name is an identifier and the color passed `isPaintColor`.
   * Each style also gets its highlight in the registry, so the rule has something to paint.
   */
  private restyle(seat: Seat): void {
    const reg = registry();
    if (reg) for (const style of seat.styles.keys()) highlightFor(reg, seat.id, style);
    const sheet = seat.sheet;
    if (!sheet) return;
    sheet.replaceSync("");
    for (const [style, color] of seat.styles) {
      try {
        sheet.insertRule(`::highlight(${highlightName(seat.id, style)}) { background-color: ${color}; }`, sheet.cssRules.length);
      } catch {
        this.dropped++;
      }
    }
  }

  private set(patch: Partial<SurfaceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }
}

export const surfaceHub = new SurfaceHub();
