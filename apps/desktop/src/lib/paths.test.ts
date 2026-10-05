import { describe, expect, it } from "vitest";
import { tildePath } from "./paths";

describe("tildePath", () => {
  it("replaces the parent of the rooms home with ~", () => {
    expect(tildePath("/Users/x/rooms/벤치마크", "/Users/x/rooms")).toBe("~/rooms/벤치마크");
    expect(tildePath("/Users/x/code/bench", "/Users/x/rooms")).toBe("~/code/bench");
    expect(tildePath("/Users/x/code/bench", "/Users/x/rooms/")).toBe("~/code/bench");
  });

  it("keeps paths outside the user home absolute", () => {
    expect(tildePath("/Volumes/ext/bench", "/Users/x/rooms")).toBe("/Volumes/ext/bench");
    expect(tildePath("/Users/xy/bench", "/Users/x/rooms")).toBe("/Users/xy/bench");
    expect(tildePath("/Users/x", "/Users/x/rooms")).toBe("/Users/x");
  });

  it("never treats / as the home", () => {
    expect(tildePath("/h/rooms/r1", "/h")).toBe("/h/rooms/r1");
    expect(tildePath("/h/rooms/r1", "")).toBe("/h/rooms/r1");
  });
});
