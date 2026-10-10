/*
 * Host text surfaces: the text the app shows that plugins may read and mark. A surface
 * (today a finished chat answer) registers its element and text index here; every plugin with
 * `surfaces.text` gets the text in its hidden background frame and answers with ranges to paint
 * and buttons for the selection bar. Core paints with the CSS Custom Highlight API and never
 * touches the surface's DOM. Everything from a frame is untrusted: shapes, sizes, offsets and
 * colors are checked here, and a surface's ranges die with the surface.
 */
import type { AskScope } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { isColor, parseActions, type ContentAction } from "@/plugins/contentChannel";
import { buildIndex, offsetOf, rangeAt, type TextIndex } from "./surfaceIndex";

export type SurfaceId = { kind: "answer"; scope: AskScope; turnId: string };

/** `answer:<scopeKey>/<turnId>`: the one name a surface has while open. */
export const surfaceKey = (s: SurfaceId): string => `${s.kind}:${scopeKey(s.scope)}/${s.turnId}`;

/** The colors a plugin may paint with. Core owns the paint, so a frame names a token, never a CSS value. */
export const SURFACE_COLORS = {
  amber: "rgba(199, 154, 62, 0.28)",
  green: "rgba(122, 153, 113, 0.26)",
  red: "rgba(190, 114, 87, 0.24)",
  violet: "rgba(142, 132, 160, 0.26)",
  blue: "rgba(96, 140, 200, 0.26)",
  gray: "rgba(140, 140, 140, 0.22)",
} as const;
export type SurfaceColor = keyof typeof SURFACE_COLORS;
const COLORS = Object.keys(SURFACE_COLORS) as SurfaceColor[];
const FLASH = "rooms-flash";

/** Ranges one `paint` may carry for one surface. */
export const MAX_RANGES = 1000;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SurfaceRange = { id: string; start: number; end: number; color: SurfaceColor };
/** Where a selection lies: inside one open surface, as offsets into its text. */
export type SurfaceSpan = { key: string; start: number; end: number };
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
  | { type: "surface.open"; surface: SurfaceId; text: string }
  | { type: "surface.close"; surface: SurfaceId }
  | { type: "selection.action"; surface: SurfaceId; actionId: string; start: number; end: number; text: string }
  | { type: "range.click"; surface: SurfaceId; rangeId: string }
  | { type: "range.action"; surface: SurfaceId; rangeId: string; actionId: string };

type FrameMessage =
  | { type: "ready" }
  | { type: "actions"; items: ContentAction[] }
  | { type: "paint"; key: string; ranges: SurfaceRange[]; dropped: number }
  | { type: "menu"; key: string; rangeId: string; items: ContentAction[] };

type OpenSurface = { id: SurfaceId; key: string; root: HTMLElement; index: TextIndex };
type Seat = { id: string; post: (m: HostMessage) => void; actions: ContentAction[]; paints: Map<string, SurfaceRange[]> };

/** The surface a plugin named, as JSON from its frame, or null. */
export function parseSurfaceId(v: unknown): SurfaceId | null {
  if (!v || typeof v !== "object") return null;
  const { kind, scope, turnId } = v as Record<string, unknown>;
  if (kind !== "answer" || typeof turnId !== "string" || !ID.test(turnId) || !scope || typeof scope !== "object") return null;
  const s = scope as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;
  if (s.kind === "doc" && str(s.fileKey)) return { kind: "answer", scope: { kind: "doc", fileKey: s.fileKey }, turnId };
  if (s.kind === "room" && str(s.roomId)) return { kind: "answer", scope: { kind: "room", roomId: s.roomId }, turnId };
  if (s.kind === "day" && typeof s.date === "string" && DATE.test(s.date)) return { kind: "answer", scope: { kind: "day", date: s.date }, turnId };
  return null;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Ranges inside `length` with a palette color and a short id; others are counted, not kept. */
function parseRanges(v: unknown, length: number): { ranges: SurfaceRange[]; dropped: number } | null {
  if (!Array.isArray(v) || v.length > MAX_RANGES) return null;
  const ranges: SurfaceRange[] = [];
  let dropped = 0;
  for (const it of v as unknown[]) {
    const { id, start, end, color } = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const ok =
      typeof id === "string" && ID.test(id) && !ranges.some((r) => r.id === id) && isInt(start) && isInt(end) && start >= 0 && start < end && end <= length && typeof color === "string" && COLORS.includes(color as SurfaceColor);
    if (ok) ranges.push({ id, start, end, color: color as SurfaceColor });
    else dropped++;
  }
  return { ranges, dropped };
}

function parseFrameMessage(data: unknown, surfaces: ReadonlyMap<string, OpenSurface>): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.rooms !== "surface" || d.v !== 1) return null;
  if (d.type === "ready") return { type: "ready" };
  if (d.type === "actions") {
    const items = parseActions(d.items, isColor);
    return items ? { type: "actions", items } : null;
  }
  const id = parseSurfaceId(d.surface);
  const open = id && surfaces.get(surfaceKey(id));
  if (!open) return null;
  if (d.type === "paint") {
    const parsed = parseRanges(d.ranges, open.index.text.length);
    return parsed ? { type: "paint", key: open.key, ...parsed } : null;
  }
  if (d.type === "menu" && typeof d.rangeId === "string" && ID.test(d.rangeId)) {
    const items = parseActions(d.items, isColor);
    return items ? { type: "menu", key: open.key, rangeId: d.rangeId, items } : null;
  }
  return null;
}

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;

const highlightName = (plugin: string, color: SurfaceColor) => `rooms-${plugin}-${color}`;

/** The caret at a point, in whichever form the engine offers. */
function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  if (typeof doc.caretPositionFromPoint === "function") {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

export class SurfaceHub {
  private surfaces = new Map<string, OpenSurface>();
  private seats = new Map<string, Seat>();
  private listeners = new Set<() => void>();
  private snapshot: SurfaceSnapshot = { actions: [], menu: null, reveal: null };
  private style: HTMLStyleElement | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Messages from a frame that were malformed, named a closed surface, or carried ranges outside the text. */
  dropped = 0;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = (): SurfaceSnapshot => this.snapshot;

  /** A surface's element and text are on screen: every background frame hears `surface.open`. */
  open(id: SurfaceId, root: HTMLElement): void {
    const key = surfaceKey(id);
    const index = buildIndex(root);
    const was = this.surfaces.get(key);
    this.surfaces.set(key, { id, key, root, index });
    for (const seat of this.seats.values()) {
      if (was) seat.paints.delete(key);
      seat.post({ type: "surface.open", surface: id, text: index.text });
    }
    if (was) this.repaintAll();
    const r = this.snapshot.reveal;
    if (r && surfaceKey(r.id) === key) {
      this.set({ reveal: null });
      setTimeout(() => this.flash(key, r.rangeId), 0);
    }
  }

  close(key: string): void {
    const s = this.surfaces.get(key);
    if (!s) return;
    this.surfaces.delete(key);
    for (const seat of this.seats.values()) {
      seat.paints.delete(key);
      seat.post({ type: "surface.close", surface: s.id });
    }
    this.repaintAll();
    if (this.snapshot.menu?.key === key) this.set({ menu: null });
  }

  /** Where a DOM range lies, when both ends are inside one open surface. */
  locate = (range: Range): SurfaceSpan | null => {
    for (const s of this.surfaces.values()) {
      if (!s.root.contains(range.startContainer) || !s.root.contains(range.endContainer)) continue;
      const start = offsetOf(s.index, range.startContainer, range.startOffset);
      const end = offsetOf(s.index, range.endContainer, range.endOffset);
      return end > start ? { key: s.key, start, end } : null;
    }
    return null;
  };

  /** One plugin's background frame: `receive` takes its messages, `dispose` forgets its paint and buttons. */
  register(plugin: string, post: (m: Record<string, unknown>) => void): { receive(data: unknown): void; dispose(): void } {
    if (!/^[a-z0-9-]{2,40}$/.test(plugin)) throw new Error(`not a plugin id: ${plugin}`);
    const seat: Seat = { id: plugin, post: (m) => post({ rooms: "surface", v: 1, ...m }), actions: [], paints: new Map() };
    this.seats.set(plugin, seat);
    this.restyle();
    return {
      receive: (data) => {
        if (!data || typeof data !== "object" || (data as { rooms?: unknown }).rooms !== "surface") return;
        const m = parseFrameMessage(data, this.surfaces);
        if (!m) {
          this.dropped++;
          return;
        }
        switch (m.type) {
          case "ready":
            for (const s of this.surfaces.values()) seat.post({ type: "surface.open", surface: s.id, text: s.index.text });
            return;
          case "actions":
            seat.actions = m.items;
            this.set({ actions: this.allActions() });
            return;
          case "paint":
            this.dropped += m.dropped;
            seat.paints.set(m.key, m.ranges);
            this.repaint(seat);
            return;
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
        for (const c of COLORS) reg?.delete(highlightName(plugin, c));
        this.restyle();
        this.set({ actions: this.allActions(), menu: this.snapshot.menu?.plugin === plugin ? null : this.snapshot.menu });
      },
    };
  }

  /** A button of `plugin` was clicked over `span`: the plugin hears where and what. */
  runAction(plugin: string, actionId: string, span: SurfaceSpan): void {
    const seat = this.seats.get(plugin);
    const s = this.surfaces.get(span.key);
    if (!seat || !s || !seat.actions.some((a) => a.id === actionId)) return;
    seat.post({ type: "selection.action", surface: s.id, actionId, start: span.start, end: span.end, text: s.index.text.slice(span.start, span.end) });
  }

  /** A click at a point in surface `key`: the plugin whose painted range is under it hears `range.click`. True when one was. */
  click(key: string, x: number, y: number): boolean {
    const s = this.surfaces.get(key);
    if (!s) return false;
    const caret = caretAt(s.root.ownerDocument, x, y);
    if (!caret || !s.root.contains(caret.node)) return false;
    const at = offsetOf(s.index, caret.node, caret.offset);
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
    this.seats.get(m.plugin)?.post({ type: "range.action", surface: s.id, rangeId: m.rangeId, actionId });
  }

  closeMenu(): void {
    if (this.snapshot.menu) this.set({ menu: null });
  }

  /** Brings a range into view and flashes it, now if its surface is open, else when it opens. */
  reveal(id: SurfaceId, rangeId: string): void {
    const key = surfaceKey(id);
    if (this.surfaces.has(key)) {
      this.set({ reveal: null });
      this.flash(key, rangeId);
    } else {
      this.set({ reveal: { id, rangeId } });
    }
  }

  private flash(key: string, rangeId: string): void {
    const s = this.surfaces.get(key);
    if (!s) return;
    s.root.scrollIntoView({ block: "center" });
    const reg = registry();
    let range: Range | null = null;
    for (const seat of this.seats.values()) range ??= this.rangeOf(seat, key, rangeId);
    if (!reg || !range) return;
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

  private repaintAll(): void {
    for (const seat of this.seats.values()) this.repaint(seat);
  }

  private repaint(seat: Seat): void {
    const reg = registry();
    if (!reg) return;
    const byColor = new Map<SurfaceColor, Range[]>(COLORS.map((c) => [c, []]));
    for (const [key, ranges] of seat.paints) {
      const s = this.surfaces.get(key);
      if (!s) continue;
      for (const r of ranges) {
        const range = rangeAt(s.index, r.start, r.end);
        if (range) byColor.get(r.color)!.push(range);
      }
    }
    for (const [color, ranges] of byColor) reg.set(highlightName(seat.id, color), new Highlight(...ranges));
  }

  /** One rule per plugin and color, plus the flash: a plugin names a token, the stylesheet holds the value. */
  private restyle(): void {
    if (typeof document === "undefined") return;
    const rules = [`::highlight(${FLASH}) { background-color: rgba(255, 196, 0, 0.55); }`];
    for (const plugin of this.seats.keys()) for (const c of COLORS) rules.push(`::highlight(${highlightName(plugin, c)}) { background-color: ${SURFACE_COLORS[c]}; }`);
    if (!this.style) {
      this.style = document.createElement("style");
      this.style.dataset.surfaceHighlights = "";
      document.head.appendChild(this.style);
    }
    this.style.textContent = rules.join("\n");
  }

  private set(patch: Partial<SurfaceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l();
  }
}

export const surfaceHub = new SurfaceHub();
