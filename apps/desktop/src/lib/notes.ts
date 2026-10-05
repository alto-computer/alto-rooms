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

/** The name a new note starts with ("New Note", then "New Note 2", …) until it is renamed. */
export const NEW_NOTE = "New Note";
const DEFAULT_NAME = /^New Note(?: [1-9]\d*)?$/;

/** The first `count` default names ("New Note", "New Note 2", …) not taken in `notes` (case-insensitively). */
export function firstNewNoteNames(notes: readonly Note[], count: number): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < count; i++) {
    const candidate = i === 1 ? NEW_NOTE : `${NEW_NOTE} ${i}`;
    if (!findNote(notes, candidate)) out.push(candidate);
  }
  return out;
}

/** The note's heading: "New Note" while it still has a default name, else its name without `.md`. */
export function noteTitle(fileName: string): string {
  const base = noteBase(fileName);
  return DEFAULT_NAME.test(base) ? NEW_NOTE : base;
}

/*
 * One-shot "put the cursor in the body" requests: a freshly created note asks
 * for it, and its view takes it once the body has loaded.
 */
const bodyFocusRequests = new Set<string>();
const focusKey = (date: string, fileName: string) => `${date}/${noteFileName(fileName).toLowerCase()}`;
export function requestNoteBodyFocus(date: string, fileName: string): void {
  bodyFocusRequests.add(focusKey(date, fileName));
}
export function takeNoteBodyFocus(date: string, fileName: string): boolean {
  return bodyFocusRequests.delete(focusKey(date, fileName));
}
