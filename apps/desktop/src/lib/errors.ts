import { RoomsApiError } from "@alto-rooms/protocol-ts";

/** Spec §3 `write_failed` copy; also the autosave error line. */
export const SAVE_FAILED = "저장하지 못했어요. 다시 시도할게요";

/** Spec §3 `invalid_room_name` copy; also an invalid note name. */
export const INVALID_NAME = "쓸 수 없는 이름이에요";

/** Spec §3 copy, verbatim, by `RoomsApiError.code`. */
const COPY: Record<string, string> = {
  invalid_room_name: INVALID_NAME,
  room_exists: "같은 이름의 방이 있어요",
  note_exists: "같은 이름의 노트가 있어요",
  unsupported_version: "앱을 업데이트해 주세요",
  write_failed: SAVE_FAILED,
  invalid_link_path: "폴더를 찾을 수 없어요",
  overlapping_room: "이미 연결된 폴더와 겹쳐요",
};

export const GENERIC_ERROR = "문제가 생겼어요";

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
export const MOVE_REFUSED = "옮길 수 없는 문서예요";

/**
 * Copy for a failed artifact move. `invalid_input` is scoped to moves here
 * (elsewhere it means other things, e.g. a bad note name), so it is not in
 * the shared table.
 */
export function moveErrorCopy(e: unknown): string {
  if (e instanceof RoomsApiError && e.code === "invalid_input") return MOVE_REFUSED;
  return errorCopy(e);
}
