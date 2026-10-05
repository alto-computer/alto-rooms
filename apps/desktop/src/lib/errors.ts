import { RoomsApiError } from "@alto-rooms/protocol-ts";

/** Spec §3 `write_failed` copy; also the autosave error line. */
export const SAVE_FAILED = "Couldn't save. Trying again";

/** Spec §3 `invalid_room_name` copy; also an invalid note name. */
export const INVALID_NAME = "That name can't be used";

/** Spec §3 copy, verbatim, by `RoomsApiError.code`. */
const COPY: Record<string, string> = {
  invalid_room_name: INVALID_NAME,
  room_exists: "A room with that name already exists",
  note_exists: "A note with that name already exists",
  unsupported_version: "Please update the app",
  write_failed: SAVE_FAILED,
  invalid_link_path: "Folder not found",
  overlapping_room: "This overlaps a folder that is already linked",
};

export const GENERIC_ERROR = "Something went wrong";

/** User-facing copy for any thrown value. */
export function errorCopy(e: unknown): string {
  if (e instanceof RoomsApiError && e.code && Object.hasOwn(COPY, e.code)) return COPY[e.code];
  return GENERIC_ERROR;
}

/**
 * Copy for a failed note rename. roomsd reports a bad note name as the generic
 * `invalid_input`; on a rename the date and the source come from the open tab,
 * so it is the new name that was refused.
 */
export function noteNameErrorCopy(e: unknown): string {
  if (e instanceof RoomsApiError && e.code === "invalid_input") return INVALID_NAME;
  return errorCopy(e);
}

/** Spec copy for a refused move (linked/journal room, bad id): roomsd says `invalid_input`. */
export const MOVE_REFUSED = "This doc can't be moved";

/**
 * Copy for a failed artifact move. `invalid_input` is scoped to moves here
 * (elsewhere it means other things, e.g. a bad note name), so it is not in
 * the shared table.
 */
export function moveErrorCopy(e: unknown): string {
  if (e instanceof RoomsApiError && e.code === "invalid_input") return MOVE_REFUSED;
  return errorCopy(e);
}
