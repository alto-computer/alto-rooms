import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";
import { errorCopy, moveErrorCopy, noteNameErrorCopy } from "./errors";

describe("errorCopy", () => {
  it("maps codes to spec §3 copy", () => {
    const c = (code: string) => errorCopy(new RoomsApiError(400, "x", code));
    expect(c("invalid_room_name")).toBe("쓸 수 없는 이름이에요");
    expect(c("room_exists")).toBe("같은 이름의 방이 있어요");
    expect(c("unsupported_version")).toBe("앱을 업데이트해 주세요");
    expect(c("write_failed")).toBe("저장하지 못했어요. 다시 시도할게요");
    expect(c("invalid_link_path")).toBe("폴더를 찾을 수 없어요");
    expect(c("overlapping_room")).toBe("이미 연결된 폴더와 겹쳐요");
    expect(c("note_exists")).toBe("같은 이름의 노트가 있어요");
  });

  it("for a note name, invalid_input is the invalid-name copy; the rest map as usual", () => {
    expect(noteNameErrorCopy(new RoomsApiError(400, "invalid input: note name", "invalid_input"))).toBe("쓸 수 없는 이름이에요");
    expect(noteNameErrorCopy(new RoomsApiError(409, "x", "note_exists"))).toBe("같은 이름의 노트가 있어요");
    expect(noteNameErrorCopy(new Error("x"))).toBe("문제가 생겼어요");
    expect(errorCopy(new RoomsApiError(400, "x", "invalid_input"))).toBe("문제가 생겼어요");
  });

  it("falls back for anything else", () => {
    expect(errorCopy(new RoomsApiError(500, "x", "nope"))).toBe("문제가 생겼어요");
    expect(errorCopy(new RoomsApiError(500, "x"))).toBe("문제가 생겼어요");
    expect(errorCopy(new Error("x"))).toBe("문제가 생겼어요");
    expect(errorCopy("x")).toBe("문제가 생겼어요");
  });
});

describe("moveErrorCopy", () => {
  it("invalid_input is 옮길 수 없는 문서예요; the rest map as usual", () => {
    expect(moveErrorCopy(new RoomsApiError(400, "linked room", "invalid_input"))).toBe("옮길 수 없는 문서예요");
    expect(moveErrorCopy(new RoomsApiError(500, "x", "write_failed"))).toBe("저장하지 못했어요. 다시 시도할게요");
    expect(moveErrorCopy(new Error("x"))).toBe("문제가 생겼어요");
  });
});
