/*
 * The host-surface side of the SDK. A plugin that declares `surfaces.text` and a `background`
 * page runs that page hidden while it is on. The app tells it the text of every chat answer on
 * screen, hands it the selections the user sends to one of its buttons, and paints the ranges it
 * answers with. Messages carry `rooms: "surface"` and go to `window.parent`; only messages whose
 * source is `window.parent` are trusted.
 */
import type { ContentAction } from "./content";

/** A chat thread: a document's, a room's, a day's, or an agent conversation's (asked in a fork of that session). */
export type AnswerScope =
  | { kind: "doc"; fileKey: string }
  | { kind: "room"; roomId: string }
  | { kind: "day"; date: string }
  | { kind: "conversation"; agent: string; session: string };

/** A piece of host text plugins may read and mark. Today: one finished chat answer. */
export type SurfaceId = { kind: "answer"; scope: AnswerScope; turnId: string };

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

/** The scope's own id: a file key, a room id, a date, or `<agent>/<session>`. */
function scopeId(scope: AnswerScope, join: string): string {
  switch (scope.kind) {
    case "doc":
      return scope.fileKey;
    case "room":
      return scope.roomId;
    case "day":
      return scope.date;
    case "conversation":
      return `${scope.agent}${join}${scope.session}`;
  }
}

/** The surface's one name: `answer:<scope>/<turnId>`, with the scope as `doc:<fileKey>`, `room:<roomId>`, `day:<date>` or `conversation:<agent>:<session>`. */
export function surfaceKey(s: SurfaceId): string {
  return `${s.kind}:${s.scope.kind}:${scopeId(s.scope, ":")}/${s.turnId}`;
}

/** The same name as a storage path: `answer/doc/<fileKey>/<turnId>`, or `answer/conversation/<agent>/<session>/<turnId>`. Ids, dates and sessions fit the path rules. */
export function surfacePath(s: SurfaceId): string {
  return `${s.kind}/${s.scope.kind}/${scopeId(s.scope, "/")}/${s.turnId}`;
}

export interface RoomsSurfaces {
  /** Replaces your buttons in the selection bar over answers, shown after Ask; at most 6. */
  setActions(items: ContentAction[]): void;
  /**
   * Replaces your ranges on one open surface; up to 1,000. `styles` declares the names the ranges
   * use, and stays declared for later paints; a range naming an undeclared style, or outside the
   * text, is dropped. A paint with a bad style name or color is refused whole.
   */
  paint(surface: SurfaceId, ranges: SurfaceRange[], styles?: SurfaceStyles): void;
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

export function connectSurfaces(): RoomsSurfaces {
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
    setActions: (items) => post({ type: "actions", items }),
    paint: (surface, ranges, styles) => post({ type: "paint", surface, ranges, ...(styles ? { styles } : {}) }),
    menu: (surface, rangeId, items) => post({ type: "menu", surface, rangeId, items }),
    onOpen: on(listeners.open),
    onClose: on(listeners.close),
    onAction: on(listeners.action),
    onRangeClick: on(listeners.rangeClick),
    onRangeAction: on(listeners.rangeAction),
    ready: () => post({ type: "ready" }),
  };
}
