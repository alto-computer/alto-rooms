import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";
import { errorCopy, moveErrorCopy, noteNameErrorCopy } from "./errors";

describe("errorCopy", () => {
  it("maps codes to spec §3 copy", () => {
    const c = (code: string) => errorCopy(new RoomsApiError(400, "x", code));
    expect(c("invalid_room_name")).toBe("That name can't be used");
    expect(c("room_exists")).toBe("A room with that name already exists");
    expect(c("unsupported_version")).toBe("Please update the app");
    expect(c("write_failed")).toBe("Couldn't save. Trying again");
    expect(c("invalid_link_path")).toBe("Folder not found");
    expect(c("overlapping_room")).toBe("This overlaps a folder that is already linked");
    expect(c("note_exists")).toBe("A note with that name already exists");
  });

  it("for a note name, invalid_input is the invalid-name copy; the rest map as usual", () => {
    expect(noteNameErrorCopy(new RoomsApiError(400, "invalid input: note name", "invalid_input"))).toBe("That name can't be used");
    expect(noteNameErrorCopy(new RoomsApiError(409, "x", "note_exists"))).toBe("A note with that name already exists");
    expect(noteNameErrorCopy(new Error("x"))).toBe("Something went wrong");
    expect(errorCopy(new RoomsApiError(400, "x", "invalid_input"))).toBe("Something went wrong");
  });

  it("falls back for anything else", () => {
    expect(errorCopy(new RoomsApiError(500, "x", "nope"))).toBe("Something went wrong");
    expect(errorCopy(new RoomsApiError(500, "x"))).toBe("Something went wrong");
    expect(errorCopy(new Error("x"))).toBe("Something went wrong");
    expect(errorCopy("x")).toBe("Something went wrong");
  });
});

describe("moveErrorCopy", () => {
  it("invalid_input is This doc can't be moved; the rest map as usual", () => {
    expect(moveErrorCopy(new RoomsApiError(400, "linked room", "invalid_input"))).toBe("This doc can't be moved");
    expect(moveErrorCopy(new RoomsApiError(500, "x", "write_failed"))).toBe("Couldn't save. Trying again");
    expect(moveErrorCopy(new Error("x"))).toBe("Something went wrong");
  });
});
