import type { Note } from "@alto-rooms/protocol-ts";

/** A note's name without its file extension: strips exactly one trailing `.md`, case-insensitively. */
export function noteBase(name: string): string {
  return name.replace(/\.md$/i, "");
}

/**
 * The file roomsd reads/writes for a note name: exactly one trailing `.md`
 * (any case) stripped, NFC, then `.md` appended. So `x.md.md` stays `x.md.md`
 * and `계획` becomes `계획.md`. Pass the on-disk name to the API unchanged.
 */
export function noteFileName(name: string): string {
  return `${noteBase(name.trim()).normalize("NFC")}.md`;
}

/** How names compare (what roomsd would map to the same file, plus case-insensitivity): trimmed, no `.md`, NFC, lowercase. */
const key = (name: string) => noteBase(name.trim()).normalize("NFC").toLowerCase();

/** The note in `notes` that `name` refers to, if any. */
export function findNote(notes: readonly Note[], name: string): Note | undefined {
  const k = key(name);
  return notes.find((n) => key(n.name) === k);
}

/** The new-note name: "계획" if there's no 계획 note yet, else "회고" if there's no 회고, else empty. */
export function defaultNoteName(notes: readonly Note[]): string {
  for (const candidate of ["계획", "회고"]) if (!findNote(notes, candidate)) return candidate;
  return "";
}
