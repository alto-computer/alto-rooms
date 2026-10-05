import type { Note } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";
import { findNote, firstNewNoteNames, noteBase, noteFileName } from "./notes";

const note = (name: string): Note => ({ date: "2026-10-05", name, relPath: `2026-10-05/${name}`, updatedAt: "2026-10-05T01:00:00Z", author: "me" });

describe("noteBase", () => {
  it("strips exactly one trailing .md, case-insensitively", () => {
    expect(noteBase("계획.md")).toBe("계획");
    expect(noteBase("계획.MD")).toBe("계획");
    expect(noteBase("a.md.md")).toBe("a.md");
    expect(noteBase("계획")).toBe("계획");
    expect(noteBase("md")).toBe("md");
  });
});

describe("findNote", () => {
  it("matches case-insensitively, ignoring .md and NFC form", () => {
    const notes = [note("Plan.md"), note("회고.md")];
    expect(findNote(notes, "plan")?.name).toBe("Plan.md");
    expect(findNote(notes, "PLAN.md")?.name).toBe("Plan.md");
    expect(findNote(notes, "회고".normalize("NFD"))?.name).toBe("회고.md");
    expect(findNote(notes, " plan ")?.name).toBe("Plan.md");
    expect(findNote(notes, "other")).toBeUndefined();
  });
});

describe("firstNewNoteNames", () => {
  it("is New Note, then New Note 2, 3, … skipping names already listed (case-insensitively)", () => {
    expect(firstNewNoteNames([], 3)).toEqual(["New Note", "New Note 2", "New Note 3"]);
    expect(firstNewNoteNames([note("new note.md")], 2)).toEqual(["New Note 2", "New Note 3"]);
    expect(firstNewNoteNames([note("New Note.md"), note("NEW NOTE 2.md"), note("New Note 4.md")], 3)).toEqual([
      "New Note 3",
      "New Note 5",
      "New Note 6",
    ]);
  });
});

describe("noteFileName", () => {
  it("matches roomsd: one .md stripped, NFC, .md appended", () => {
    expect(noteFileName("계획")).toBe("계획.md");
    expect(noteFileName("계획.md")).toBe("계획.md");
    expect(noteFileName("Plan.MD")).toBe("Plan.md");
    expect(noteFileName("x.md.md")).toBe("x.md.md");
    expect(noteFileName(noteFileName("x.md.md"))).toBe("x.md.md");
    expect(noteFileName("회고".normalize("NFD"))).toBe("회고.md");
  });
});
