import { RoomsApiError } from "@alto-rooms/protocol-ts";

/** Spec §3 copy, verbatim, by `RoomsApiError.code`. */
const COPY: Record<string, string> = {
  invalid_room_name: "쓸 수 없는 이름이에요",
  room_exists: "같은 이름의 방이 있어요",
  unsupported_version: "앱을 업데이트해 주세요",
  write_failed: "저장하지 못했어요. 다시 시도할게요",
  invalid_link_path: "폴더를 찾을 수 없어요",
  overlapping_room: "이미 연결된 폴더와 겹쳐요",
};

export const GENERIC_ERROR = "문제가 생겼어요";

/** User-facing copy for any thrown value. */
export function errorCopy(e: unknown): string {
  if (e instanceof RoomsApiError && e.code && Object.hasOwn(COPY, e.code)) return COPY[e.code];
  return GENERIC_ERROR;
}
