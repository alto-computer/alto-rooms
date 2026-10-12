import type { DragEvent } from "react";
import type { SessionRef } from "@alto-rooms/protocol-ts";
import { isAgent, isSessionId } from "./agents";

/** The inbox room's id: where artifacts wait until they are moved to a room. */
export const INBOX_ID = "inbox";

/** HTML5 drag type for moving an artifact between rooms; the data is JSON `{roomId, artifactId}`. */
export const ARTIFACT_DRAG_TYPE = "application/x-rooms-artifact";

export type ArtifactDragPayload = { roomId: string; artifactId: string };

/** HTML5 drag type for putting a Journal session in a room; the data is JSON `{sessionRef, roomId}`. */
export const SESSION_DRAG_TYPE = "application/x-rooms-session";

/** `roomId`: the room the session is in now, if any. */
export type SessionDragPayload = { sessionRef: SessionRef; roomId: string | null };

/**
 * The source room of the drag in progress (null for a session in no room), set on dragstart
 * and cleared on dragend. Browsers hide drag data until drop, so drop targets read this to
 * refuse the source room while hovering.
 */
let current: { roomId: string | null } | null = null;

/** Props that make an element an artifact drag source. */
export function artifactDragSource(payload: ArtifactDragPayload) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(ARTIFACT_DRAG_TYPE, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      current = payload;
    },
    onDragEnd: () => {
      current = null;
    },
  };
}

/** Forgets the drag in progress (a drop target handled it). */
export function endDrag(): void {
  current = null;
}

/** The source room of the drag in progress, if it started in this window. */
export const draggingFromRoom = (): string | null => current?.roomId ?? null;

const carries = (dt: DataTransfer | null | undefined, type: string) => !!dt && Array.from(dt.types ?? []).includes(type);

/** True when the drag carries an artifact (by type; the data itself is readable only on drop). */
export const carriesArtifact = (dt: DataTransfer | null | undefined): boolean => carries(dt, ARTIFACT_DRAG_TYPE);

/** True when the drag carries a session. */
export const carriesSession = (dt: DataTransfer | null | undefined): boolean => carries(dt, SESSION_DRAG_TYPE);

/** Props that make an element a session drag source. */
export function sessionDragSource(payload: SessionDragPayload) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      current = payload;
    },
    onDragEnd: () => {
      current = null;
    },
  };
}

/** The dropped session, or null when it is missing or malformed. */
export function readSessionPayload(dt: DataTransfer | null | undefined): SessionDragPayload | null {
  const raw = dt?.getData(SESSION_DRAG_TYPE);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { sessionRef?: { agent?: unknown; id?: unknown }; roomId?: unknown } | null;
    const agent = v?.sessionRef?.agent;
    const id = v?.sessionRef?.id;
    const roomId = v?.roomId ?? null;
    if (!isAgent(agent) || !isSessionId(id)) return null;
    if (roomId !== null && typeof roomId !== "string") return null;
    return { sessionRef: { agent, id }, roomId };
  } catch {
    return null;
  }
}

/** The dropped payload, or null when it is missing or malformed. */
export function readArtifactPayload(dt: DataTransfer | null | undefined): ArtifactDragPayload | null {
  const raw = dt?.getData(ARTIFACT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { roomId, artifactId } = v as Record<string, unknown>;
    if (typeof roomId !== "string" || typeof artifactId !== "string" || !roomId || !artifactId) return null;
    return { roomId, artifactId };
  } catch {
    return null;
  }
}
