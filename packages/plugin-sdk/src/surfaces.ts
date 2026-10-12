/*
 * The host-surface side of the SDK. A plugin that declares `surfaces.text` and a `background`
 * page runs that page hidden while it is on. The app tells it the text of every chat answer and
 * open note on screen, hands it the selections the user sends to one of its buttons, and paints
 * the ranges it answers with. Messages carry `rooms: "surface"` and go to `window.parent`; only
 * messages whose source is `window.parent` are trusted. Each one also carries `api: 2`, and
 * `connectSurfaces` says `hello` at once, so the app sends this SDK's scope shapes; a page that
 * never says so is sent SDK 0.5's (`doc`, and `conversation` with the id in `session`).
 */
import type { ContentAction } from "./content";

/** A chat thread: an artifact's, a room's, a day's, or an agent session's (asked in a fork of that session). */
export type AnswerScope =
  | { kind: "artifact"; fileKey: string }
  | { kind: "room"; roomId: string }
  | { kind: "day"; date: string }
  | { kind: "session"; agent: string; id: string };

/**
 * A piece of host text plugins may read and mark: one finished chat answer, or the body of a note
 * in the Journal. A note's `name` is its file name with `.md`, as the user spelled it; two
 * spellings of one file (case, Unicode form) are one surface, so key it by `surfaceKey` or
 * `surfacePath`, never by `name`.
 */
export type SurfaceId = { kind: "answer"; scope: AnswerScope; turnId: string } | { kind: "note"; date: string; name: string };

/**
 * Your paint styles: a name to the CSS color it paints with. A name is up to 32 of `a-z 0-9 -`,
 * starting with a letter; a color is a hex value, a color name, or one of the color functions
 * (`rgb`, `hsl`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`, `color-mix`, `light-dark`) that
 * the app's browser accepts, up to 64 characters. Not `var()`, `env()` or any other substitution,
 * and no quotes, braces, semicolons or escapes. The app keeps up to 16 names per plugin and draws
 * each as one highlight.
 */
export type SurfaceStyles = Record<string, string>;

/** `[start, end)` offsets into the surface's text, as `onOpen` gave it. */
export interface SurfaceRange {
  /** Up to 64 of `A-Z a-z 0-9 _ . : -`; unique within one paint. */
  id: string;
  start: number;
  end: number;
  /** A name from the styles you declared. */
  style: string;
}

/** What the user selected when one of your buttons was clicked. */
export interface SurfaceSelection {
  surface: SurfaceId;
  start: number;
  end: number;
  text: string;
}

/** The scope's own id: a file key, a room id, a date, or `<agent>/<id>`. */
function scopeId(scope: AnswerScope, join: string): string {
  switch (scope.kind) {
    case "artifact":
      return scope.fileKey;
    case "room":
      return scope.roomId;
    case "day":
      return scope.date;
    case "session":
      return `${scope.agent}${join}${scope.id}`;
  }
}

/** A note name the way the disk compares it: NFC, then lowercase. */
const fold = (name: string) => name.normalize("NFC").toLowerCase();

/** FNV-1a over the UTF-16 units of `s`, as 8 hex digits. */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * A note name as one storage path segment: the folded name's path-safe characters, at most 40,
 * then a hash of the whole folded name, so `Plan.md` reads as `plan.md-<hash>` and a name in
 * another script still gets a segment of its own.
 */
function noteSegment(name: string): string {
  const folded = fold(name);
  const readable = folded.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 40);
  return `${readable}${readable ? "-" : ""}${hash8(folded)}`;
}

/**
 * The surface's one name: `answer:<scope>/<turnId>`, with the scope as `artifact:<fileKey>`, `room:<roomId>`,
 * `day:<date>` or `session:<agent>:<id>`; `note:<date>/<folded name>` for a note.
 */
export function surfaceKey(s: SurfaceId): string {
  if (s.kind === "note") return `note:${s.date}/${fold(s.name)}`;
  return `${s.kind}:${s.scope.kind}:${scopeId(s.scope, ":")}/${s.turnId}`;
}

/**
 * The same name as a storage path: `answer/artifact/<fileKey>/<turnId>`, `answer/session/<agent>/<id>/<turnId>`,
 * or `note/<date>/<segment>`. Ids, dates and session ids fit the path rules; a note's name is made to.
 */
export function surfacePath(s: SurfaceId): string {
  if (s.kind === "note") return `note/${s.date}/${noteSegment(s.name)}`;
  return `${s.kind}/${s.scope.kind}/${scopeId(s.scope, "/")}/${s.turnId}`;
}

/**
 * The storage path SDK 0.5 gave this surface: `answer/doc/<fileKey>/<turnId>` for an artifact,
 * `answer/conversation/<agent>/<id>/<turnId>` for a session, the same as `surfacePath` otherwise
 * (0.5 had no notes). Read it when `surfacePath` finds nothing, to pick up data saved before 0.6,
 * and move it.
 * @deprecated Goes in 0.7.
 */
export function legacySurfacePath(s: SurfaceId): string {
  if (s.kind === "note") return surfacePath(s);
  const old: Record<AnswerScope["kind"], string> = { artifact: "doc", room: "room", day: "day", session: "conversation" };
  return `${s.kind}/${old[s.scope.kind]}/${scopeId(s.scope, "/")}/${s.turnId}`;
}

export interface RoomsSurfaces {
  /** Replaces your buttons in the selection bar over answers, shown after Ask; at most 6. */
  setActions(items: ContentAction[]): void;
  /**
   * Replaces your ranges on one open surface; up to 1,000. `styles` declares the names the ranges
   * use, and stays declared for later paints; a range naming an undeclared style, or outside the
   * text, is dropped. A paint with a bad style name or color is refused whole. `version` names
   * the text the offsets index, as `onOpen` gave it with that text: pass it whenever you paint
   * after an `await`, since a newer text may have arrived meanwhile. Without it the offsets are
   * read against the text you last heard. Either way a paint lands on its words while the user
   * types, and one against an older text is ignored; you hear the newer text.
   */
  paint(surface: SurfaceId, ranges: SurfaceRange[], styles?: SurfaceStyles, version?: number): void;
  /** Shows a menu over one of your painted ranges, in the same shape as `setActions`; at most 6. */
  menu(surface: SurfaceId, rangeId: string, items: ContentAction[]): void;
  /**
   * A surface is on screen with this text. Also fires for every open surface right after `ready()`,
   * and again when its text changes: for a note, once the user pauses typing. The app moves your
   * paint through each keystroke meanwhile; re-anchor from your quotes here and paint again.
   * `version` is the app's number for this text; hand it to `paint` with offsets computed on it.
   */
  onOpen(cb: (surface: SurfaceId, text: string, version: number) => void): () => void;
  /** A surface left the screen; its paint is gone with it. */
  onClose(cb: (surface: SurfaceId) => void): () => void;
  /** One of your buttons was clicked over a selection. */
  onAction(cb: (actionId: string, selection: SurfaceSelection) => void): () => void;
  /** The user clicked one of your painted ranges. Answer with `menu()` or do nothing. */
  onRangeClick(cb: (surface: SurfaceId, rangeId: string) => void): () => void;
  /** The user picked an item from the menu you showed on a range. */
  onRangeAction(cb: (surface: SurfaceId, rangeId: string, actionId: string) => void): () => void;
  /** Tells the app this page is listening; the app answers with `onOpen` for every surface on screen. */
  ready(): void;
}

type Inbound =
  | { type: "surface.open"; surface: SurfaceId; text: string; version: number }
  | { type: "surface.close"; surface: SurfaceId }
  | { type: "selection.action"; surface: SurfaceId; actionId: string; start: number; end: number; text: string }
  | { type: "range.click"; surface: SurfaceId; rangeId: string }
  | { type: "range.action"; surface: SurfaceId; rangeId: string; actionId: string };

export function connectSurfaces(): RoomsSurfaces {
  const parent = window.parent;
  const post = (m: Record<string, unknown>) => parent.postMessage({ rooms: "surface", v: 1, api: 2, ...m }, "*");
  const listeners = {
    open: new Set<(s: SurfaceId, text: string, version: number) => void>(),
    close: new Set<(s: SurfaceId) => void>(),
    action: new Set<(id: string, sel: SurfaceSelection) => void>(),
    rangeClick: new Set<(s: SurfaceId, rangeId: string) => void>(),
    rangeAction: new Set<(s: SurfaceId, rangeId: string, actionId: string) => void>(),
  };
  const on = <T extends unknown[]>(set: Set<(...a: T) => void>) => (cb: (...a: T) => void) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  const fire = <T extends unknown[]>(set: Set<(...a: T) => void>, ...a: T) => {
    for (const l of [...set]) l(...a);
  };
  /** The version of the text last heard per open surface: what a paint names when the plugin names none. */
  const heard = new Map<string, number>();

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent) return;
    const d = e.data as ({ rooms?: unknown; v?: unknown } & Inbound) | null;
    if (!d || typeof d !== "object" || d.rooms !== "surface" || d.v !== 1) return;
    switch (d.type) {
      case "surface.open":
        heard.set(surfaceKey(d.surface), d.version);
        return fire(listeners.open, d.surface, d.text, d.version);
      case "surface.close":
        heard.delete(surfaceKey(d.surface));
        return fire(listeners.close, d.surface);
      case "selection.action":
        return fire(listeners.action, d.actionId, { surface: d.surface, start: d.start, end: d.end, text: d.text });
      case "range.click":
        return fire(listeners.rangeClick, d.surface, d.rangeId);
      case "range.action":
        return fire(listeners.rangeAction, d.surface, d.rangeId, d.actionId);
    }
  });
  post({ type: "hello" });

  return {
    setActions: (items) => post({ type: "actions", items }),
    paint: (surface, ranges, styles, version = heard.get(surfaceKey(surface))) => {
      post({ type: "paint", surface, ranges, ...(styles ? { styles } : {}), ...(version === undefined ? {} : { version }) });
    },
    menu: (surface, rangeId, items) => post({ type: "menu", surface, rangeId, items }),
    onOpen: on(listeners.open),
    onClose: on(listeners.close),
    onAction: on(listeners.action),
    onRangeClick: on(listeners.rangeClick),
    onRangeAction: on(listeners.rangeAction),
    ready: () => post({ type: "ready" }),
  };
}
