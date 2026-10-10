import type { RoomColor } from "@alto-rooms/protocol-ts";

/** Every room colour with its name, in hue order: the order the Colour menu lists them. */
export const ROOM_COLOR_NAMES: Record<RoomColor, string> = {
  rose: "Rose",
  clay: "Clay",
  oat: "Oat",
  sage: "Sage",
  sea: "Sea",
  dusk: "Dusk",
  lilac: "Lilac",
  stone: "Stone",
};

export const ROOM_COLORS = Object.keys(ROOM_COLOR_NAMES) as RoomColor[];

/**
 * Spread on an element to give it and its children a room's tint: `bg-room-band` paints the
 * room's header band (warm paper when the room is not pinned), `bg-room-dot` its colour dot
 * (transparent when not pinned). The values live in styles.css under `[data-tint]`.
 */
export const roomTint = (color: RoomColor | null) => ({ "data-tint": color ?? "none" });
