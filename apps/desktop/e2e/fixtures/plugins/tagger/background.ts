// The tagger's background page for the e2e tests: one "Tag" button over answer text, tags stored per
// answer as quote + context and re-anchored on every open, a menu on a tagged range with Untag and
// Open. `window.tagger` lets a test post hostile paint or call open from this frame.
import { connect, connectSurfaces, surfacePath, type SurfaceId, type SurfaceRange, type SurfaceStyles } from "@alto-rooms/plugin-sdk";

type Tag = { id: string; quote: string; prefix: string; suffix: string; start: number };
type File = { version: 1; tags: Tag[] };

const CONTEXT = 40;
/** Hi-Lighter's four document colors, so an answer tag reads like a document highlight. */
const STYLES: SurfaceStyles = {
  important: "rgba(199,154,62,0.28)",
  agree: "rgba(122,153,113,0.26)",
  disagree: "rgba(190,114,87,0.24)",
  idk: "rgba(142,132,160,0.26)",
};
const STYLE_NAMES = Object.keys(STYLES);

const rooms = await connect();
const surfaces = connectSurfaces();
const open = new Map<string, { surface: SurfaceId; text: string }>();
const file = (s: SurfaceId) => `${surfacePath(s)}.json`;

async function load(s: SurfaceId): Promise<File> {
  const raw = await rooms.storage.read(file(s));
  return raw ? (JSON.parse(raw) as File) : { version: 1, tags: [] };
}

/** Where a tag sits in `text` now: its quote with the same context, else the first occurrence of the quote. */
function anchor(text: string, t: Tag): number {
  const exact = text.indexOf(t.prefix + t.quote + t.suffix);
  if (exact >= 0) return exact + t.prefix.length;
  const near = text.indexOf(t.quote, Math.max(0, t.start - 200));
  return near >= 0 ? near : text.indexOf(t.quote);
}

async function repaint(s: SurfaceId) {
  const entry = open.get(surfacePath(s));
  if (!entry) return;
  const { tags } = await load(s);
  const ranges: SurfaceRange[] = [];
  tags.forEach((t, i) => {
    const start = anchor(entry.text, t);
    if (start >= 0) ranges.push({ id: t.id, start, end: start + t.quote.length, style: STYLE_NAMES[i % STYLE_NAMES.length] });
  });
  surfaces.paint(s, ranges, STYLES);
}

surfaces.onOpen((s, text) => {
  open.set(surfacePath(s), { surface: s, text });
  void repaint(s);
});
surfaces.onClose((s) => void open.delete(surfacePath(s)));

surfaces.onAction(async (id, sel) => {
  if (id !== "tag") return;
  const entry = open.get(surfacePath(sel.surface));
  if (!entry) return;
  const data = await load(sel.surface);
  data.tags.push({
    id: `t${Date.now().toString(36)}${data.tags.length}`,
    quote: sel.text,
    prefix: entry.text.slice(Math.max(0, sel.start - CONTEXT), sel.start),
    suffix: entry.text.slice(sel.end, sel.end + CONTEXT),
    start: sel.start,
  });
  await rooms.storage.write(file(sel.surface), JSON.stringify(data));
  await repaint(sel.surface);
});

surfaces.onRangeClick((s, rangeId) => {
  surfaces.menu(s, rangeId, [
    { id: "untag", title: "Untag" },
    { id: "open", title: "Open", color: "#2f6fdd" },
  ]);
});

surfaces.onRangeAction(async (s, rangeId, actionId) => {
  if (actionId === "untag") {
    const data = await load(s);
    data.tags = data.tags.filter((t) => t.id !== rangeId);
    await rooms.storage.write(file(s), JSON.stringify(data));
    await repaint(s);
  }
  if (actionId === "open") await rooms.open({ surface: s, rangeId });
});

surfaces.setActions([{ id: "tag", title: "Tag", color: "#ffd400" }]);
surfaces.ready();

declare global {
  interface Window {
    tagger: {
      surfaces(): SurfaceId[];
      /**
       * Posts a paint with one good range and two the app must drop (an undeclared style, a range past
       * the text), then one the app must refuse whole: a style named to break out of its rule and a
       * color that is not one.
       */
      hostile(): void;
      open(surface: SurfaceId, rangeId: string): Promise<void>;
      tagged(): Promise<string[]>;
      fetchBlocked(url: string): Promise<boolean>;
      /** Paints `n` word-sized ranges over the longest open surface, for the perf probe. */
      paintMany(n: number): void;
    };
  }
}

window.tagger = {
  surfaces: () => [...open.values()].map((e) => e.surface),
  hostile() {
    const post = (m: Record<string, unknown>) => window.parent.postMessage({ rooms: "surface", v: 1, type: "paint", ...m }, "*");
    for (const { surface, text } of open.values()) {
      post({
        surface,
        styles: STYLES,
        ranges: [
          { id: "ok", start: 0, end: 4, style: "agree" },
          { id: "undeclared", start: 0, end: 1, style: "pink" },
          { id: "past", start: 0, end: text.length + 10, style: "disagree" },
        ],
      });
      post({ surface, styles: { "x;}body{display:none": "red" }, ranges: [{ id: "inject", start: 0, end: 1, style: "x;}body{display:none" }] });
      post({ surface, styles: { css: "url(x)" }, ranges: [{ id: "css", start: 0, end: 1, style: "css" }] });
    }
  },
  open: (surface, rangeId) => rooms.open({ surface, rangeId }),
  tagged: () => rooms.storage.list("answer/"),
  fetchBlocked: (url) => fetch(url).then(() => false, () => true),
  paintMany(n) {
    const longest = [...open.values()].sort((a, b) => b.text.length - a.text.length)[0];
    if (!longest) return;
    const step = Math.max(6, Math.floor(longest.text.length / n));
    const ranges: SurfaceRange[] = [];
    for (let i = 0; i < n && i * step + 5 <= longest.text.length; i++) ranges.push({ id: `m${i}`, start: i * step, end: i * step + 5, style: "important" });
    surfaces.paint(longest.surface, ranges, STYLES);
  },
};
