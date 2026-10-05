import type { DragEvent } from "react";

/** The inbox room's id: where docs wait until they are moved to a room. */
export const INBOX_ID = "inbox";

/** HTML5 drag type for moving an artifact between rooms; the data is JSON `{roomId, artifactId}`. */
export const ARTIFACT_DRAG_TYPE = "application/x-rooms-artifact";

export type ArtifactDragPayload = { roomId: string; artifactId: string };

/**
 * The payload of the drag in progress, set on dragstart and cleared on
 * dragend. Browsers hide drag data until drop, so drop targets read this to
 * refuse the source room while hovering.
 */
let current: ArtifactDragPayload | null = null;

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
export function endArtifactDrag(): void {
  current = null;
}

/** The source room of the drag in progress, if it started in this window. */
export const draggingFromRoom = (): string | null => current?.roomId ?? null;

/** True when the drag carries an artifact (by type; the data itself is readable only on drop). */
export function carriesArtifact(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes(ARTIFACT_DRAG_TYPE);
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
