import type { Note } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";
import { findNote, firstNewNoteNames, freeNoteNames, noteBase, noteFileName, noteNameFromQuestion } from "./notes";

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

/** A port of roomsd's `validate_note_name` (crates/rooms-core/src/rules.rs). */
function roomsdAccepts(name: string): boolean {
  const base = noteBase(name.trim()).normalize("NFC");
  const n = Array.from(base).length;
  return n > 0 && n <= 60 && !/[/\\:]/.test(base) && !base.includes("..") && !base.startsWith(".") && !/\p{Cc}/u.test(base);
}

describe("noteNameFromQuestion", () => {
  const cases: [string, string, string][] = [
    ["Korean text", "이번 주 회의에서 정한 것들 정리해줘", "이번 주 회의에서 정한 것들 정리해줘"],
    ["forbidden characters", "a/b:c..d\\e", "a b c d e"],
    ["a leading dot", ".hidden files?", "hidden files?"],
    ["leading dots behind spaces", "  .. ./x", "x"],
    ["control characters and newlines", "first\tline\nsecond\u0007line", "first line second line"],
    ["no spaces", "x".repeat(200), "x".repeat(55)],
    ["only whitespace", " \n\t ", "Answer"],
    ["only forbidden characters", "/..:\\", "Answer"],
    ["a quote block first", "> picked text\n> more\n\nWhat does this mean?", "What does this mean?"],
  ];
  it.each(cases)("%s", (_, question, expected) => {
    const name = noteNameFromQuestion(question);
    expect(name).toBe(expected);
    expect(roomsdAccepts(name)).toBe(true);
  });

  it("cuts at the last word boundary within 55 characters", () => {
    const question = `${"word ".repeat(10)}abcdefghij`;
    expect(Array.from(question).length).toBe(60);
    expect(noteNameFromQuestion(question)).toBe("word ".repeat(10).trim());
  });

  it("keeps a word that ends exactly at 55 characters", () => {
    expect(noteNameFromQuestion(`${"a".repeat(55)} tail`)).toBe("a".repeat(55));
  });

  it("counts characters the way roomsd does, so a name plus \" (2)\" still fits", () => {
    const name = noteNameFromQuestion("😀".repeat(70));
    expect(Array.from(name).length).toBe(55);
    expect(roomsdAccepts(`${name} (2)`)).toBe(true);
  });

  it("measures the NFC form, not the decomposed one a paste may bring", () => {
    const name = noteNameFromQuestion("회의".repeat(40).normalize("NFD"));
    expect(name).toBe("회의".repeat(40).slice(0, 55));
    expect(roomsdAccepts(`${name} (2)`)).toBe(true);
  });
});

describe("freeNoteNames", () => {
  it("is the name, then (2), (3), … skipping names already listed (case-insensitively)", () => {
    expect(freeNoteNames("Plan", [], 3)).toEqual(["Plan", "Plan (2)", "Plan (3)"]);
    expect(freeNoteNames("Plan", [note("plan.md"), note("PLAN (2).md")], 2)).toEqual(["Plan (3)", "Plan (4)"]);
    expect(freeNoteNames("회의", [note("회의.md".normalize("NFD"))], 1)).toEqual(["회의 (2)"]);
  });
});
