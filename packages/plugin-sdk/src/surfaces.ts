/*
 * The host-surface side of the SDK. A plugin that declares `surfaces.text` and a `background`
 * page runs that page hidden while it is on. The app tells it the text of every chat answer on
 * screen, hands it the selections the user sends to one of its buttons, and paints the ranges it
 * answers with. Messages carry `rooms: "surface"` and go to `window.parent`; only messages whose
 * source is `window.parent` are trusted.
 */
import type { ContentAction } from "./content";

/** A chat thread: a document's, a room's, or a day's. */
export type AnswerScope = { kind: "doc"; fileKey: string } | { kind: "room"; roomId: string } | { kind: "day"; date: string };

/** A piece of host text plugins may read and mark. Today: one finished chat answer. */
export type SurfaceId = { kind: "answer"; scope: AnswerScope; turnId: string };

/** The colors the app paints with. The app owns the paint, so a range names a token, never a CSS value. */
export type SurfaceColor = "amber" | "green" | "red" | "violet" | "blue" | "gray";

/** `[start, end)` offsets into the surface's text, as `onOpen` gave it. */
export interface SurfaceRange {
  /** Up to 64 of `A-Z a-z 0-9 _ . : -`; unique within one paint. */
  id: string;
  start: number;
  end: number;
  color: SurfaceColor;
}

/** What the user selected when one of your buttons was clicked. */
export interface SurfaceSelection {
  surface: SurfaceId;
  start: number;
  end: number;
  text: string;
}

/** The surface's one name: `answer:<scope>/<turnId>`, with the scope as `doc:<fileKey>`, `room:<roomId>` or `day:<date>`. */
export function surfaceKey(s: SurfaceId): string {
  const scope = s.scope.kind === "doc" ? `doc:${s.scope.fileKey}` : s.scope.kind === "room" ? `room:${s.scope.roomId}` : `day:${s.scope.date}`;
  return `${s.kind}:${scope}/${s.turnId}`;
}

/** The same name as a storage path: `answer/doc/<fileKey>/<turnId>`. Ids and dates fit the path rules. */
export function surfacePath(s: SurfaceId): string {
  const id = s.scope.kind === "doc" ? s.scope.fileKey : s.scope.kind === "room" ? s.scope.roomId : s.scope.date;
  return `${s.kind}/${s.scope.kind}/${id}/${s.turnId}`;
}

export interface RoomsSurfaces {
  readonly pluginId: string;
  /** Replaces your buttons in the selection bar over answers, shown after Ask; at most 6. */
  setActions(items: ContentAction[]): void;
  /** Replaces your ranges on one open surface; up to 1,000. Offsets outside the text and unknown colors are dropped. */
  paint(surface: SurfaceId, ranges: SurfaceRange[]): void;
  /** Shows a menu over one of your painted ranges, in the same shape as `setActions`; at most 6. */
  menu(surface: SurfaceId, rangeId: string, items: ContentAction[]): void;
  /** A surface is on screen with this text. Also fires for every open surface right after `ready()`, and again when an answer's text changes. */
  onOpen(cb: (surface: SurfaceId, text: string) => void): () => void;
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
  | { type: "surface.open"; surface: SurfaceId; text: string }
  | { type: "surface.close"; surface: SurfaceId }
  | { type: "selection.action"; surface: SurfaceId; actionId: string; start: number; end: number; text: string }
  | { type: "range.click"; surface: SurfaceId; rangeId: string }
  | { type: "range.action"; surface: SurfaceId; rangeId: string; actionId: string };

export function connectSurfaces(pluginId: string): RoomsSurfaces {
  const parent = window.parent;
  const post = (m: Record<string, unknown>) => parent.postMessage({ rooms: "surface", v: 1, ...m }, "*");
  const listeners = {
    open: new Set<(s: SurfaceId, text: string) => void>(),
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

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent) return;
    const d = e.data as ({ rooms?: unknown; v?: unknown } & Inbound) | null;
    if (!d || typeof d !== "object" || d.rooms !== "surface" || d.v !== 1) return;
    switch (d.type) {
      case "surface.open":
        return fire(listeners.open, d.surface, d.text);
      case "surface.close":
        return fire(listeners.close, d.surface);
      case "selection.action":
        return fire(listeners.action, d.actionId, { surface: d.surface, start: d.start, end: d.end, text: d.text });
      case "range.click":
        return fire(listeners.rangeClick, d.surface, d.rangeId);
      case "range.action":
        return fire(listeners.rangeAction, d.surface, d.rangeId, d.actionId);
    }
  });

  return {
    pluginId,
    setActions: (items) => post({ type: "actions", items }),
    paint: (surface, ranges) => post({ type: "paint", surface, ranges }),
    menu: (surface, rangeId, items) => post({ type: "menu", surface, rangeId, items }),
    onOpen: on(listeners.open),
    onClose: on(listeners.close),
    onAction: on(listeners.action),
    onRangeClick: on(listeners.rangeClick),
    onRangeAction: on(listeners.rangeAction),
    ready: () => post({ type: "ready" }),
  };
}
