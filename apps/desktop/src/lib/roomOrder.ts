import type { Room } from "@alto-rooms/protocol-ts";
import { INBOX_ID } from "./drag";

/**
 * The room ids after `moveRoom(id, to)`, as the core orders them (rooms-core `move_within_section`):
 * `to` counts the rooms other than the inbox, which keeps its index, and the room stays in its own
 * section, so a pinned room stops at the end of the pinned rooms and an unpinned one at their start.
 */
export function moveWithinSection(rooms: Room[], id: string, to: number): string[] {
  const inboxAt = rooms.findIndex((r) => r.id === INBOX_ID);
  const rest = rooms.filter((r) => r.id !== INBOX_ID);
  const from = rest.findIndex((r) => r.id === id);
  if (from < 0) return rooms.map((r) => r.id);
  const [moved] = rest.splice(from, 1);
  const pinned = rest.findIndex((r) => r.color === null);
  const pinnedLen = pinned < 0 ? rest.length : pinned;
  const at = moved.color !== null ? Math.min(to, pinnedLen) : Math.min(Math.max(to, pinnedLen), rest.length);
  rest.splice(at, 0, moved);
  const ids = rest.map((r) => r.id);
  if (inboxAt >= 0) ids.splice(Math.min(inboxAt, ids.length), 0, INBOX_ID);
  return ids;
}
