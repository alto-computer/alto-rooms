import type { RoomColor } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";
import { room } from "@/test/fakes";
import { moveWithinSection } from "./roomOrder";

/** `inbox` and plain ids are neutral; `id:colour` is pinned (`a:sage`), as in rooms-core's order tests. */
const list = (spec: string) =>
  spec.split(" ").map((s) => {
    const [id, color] = s.split(":");
    return room(id, id, { color: (color as RoomColor | undefined) ?? null });
  });
const move = (spec: string, id: string, to: number) => moveWithinSection(list(spec), id, to).join(" ");

// The same cases as rooms-core's `moves_stay_within_their_section`, so the sidebar's pending order is the one the core will send.
describe("moveWithinSection", () => {
  it("moves within the pinned rooms", () => {
    expect(move("inbox a:sage b:sage c:sage d e f", "c", 0)).toBe("inbox c a b d e f");
  });

  it("stops a pinned room at the end of the pinned rooms", () => {
    expect(move("inbox c:sage a:sage b:sage d e f", "c", 5)).toBe("inbox a b c d e f");
  });

  it("stops an unpinned room at the top of the unpinned rooms, and at the end", () => {
    expect(move("inbox a:sage b:sage c:sage d e f", "f", 0)).toBe("inbox a b c f d e");
    expect(move("inbox a:sage b:sage c:sage f d e", "f", 99)).toBe("inbox a b c d e f");
  });

  it("counts `to` without the inbox, which keeps its index", () => {
    expect(move("inbox a:sage b:sage c:sage d e f", "d", 4)).toBe("inbox a b c e d f");
    expect(move("a inbox b c", "c", 0)).toBe("c inbox a b");
  });

  it("leaves the order alone for an unknown room", () => {
    expect(move("inbox a b", "nope", 0)).toBe("inbox a b");
  });
});
