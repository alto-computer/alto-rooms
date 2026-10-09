import { RoomsApiError, type Note } from "@alto-rooms/protocol-ts";
import { splitQuotes } from "@/ask/quotes";

/** A note's name without its file extension: strips exactly one trailing `.md`, case-insensitively. */
export function noteBase(name: string): string {
  return name.replace(/\.md$/i, "");
}

/**
 * The file roomsd reads/writes for a note name: exactly one trailing `.md`
 * (any case) stripped, NFC, then `.md` appended. So `x.md.md` stays `x.md.md`
 * and `Plan` becomes `Plan.md`. Pass the on-disk name to the API unchanged.
 */
export function noteFileName(name: string): string {
  return `${noteBase(name.trim()).normalize("NFC")}.md`;
}

/** Folds a name the way macOS's case-insensitive disk compares it: NFC, then lowercase. */
const fold = (name: string) => name.normalize("NFC").toLowerCase();

/**
 * The key for one note file: `${date}/${fileName}` with the on-disk file name
 * (with `.md`) folded, so `Plan.md` and `plan.md`, one file on disk, share it.
 */
export const noteKey = (date: string, fileName: string) => `${date}/${fold(fileName)}`;

/** How names compare (what roomsd would map to the same file, plus case-insensitivity): trimmed, no `.md`, folded. */
const key = (name: string) => fold(noteBase(name.trim()));

/** The note in `notes` that `name` refers to, if any. */
export function findNote(notes: readonly Note[], name: string): Note | undefined {
  const k = key(name);
  return notes.find((n) => key(n.name) === k);
}

/** The name a new note starts with ("New Note", then "New Note 2", …) until it is renamed. */
export const NEW_NOTE = "New Note";

/** The first `count` default names ("New Note", "New Note 2", …) not taken in `notes` (case-insensitively). */
export function firstNewNoteNames(notes: readonly Note[], count: number): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < count; i++) {
    const candidate = i === 1 ? NEW_NOTE : `${NEW_NOTE} ${i}`;
    if (!findNote(notes, candidate)) out.push(candidate);
  }
  return out;
}

/** Longest name a saved answer starts with: roomsd allows 60 characters, which leaves room for " (2)". */
export const MAX_QUESTION_NAME = 55;
/** The name of a saved answer whose question leaves nothing usable. */
const ANSWER_NOTE = "Answer";

/** At most `max` characters of `s`, cut at the last space when there is one. */
function cutAtWord(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const head = chars.slice(0, max + 1).join("");
  const space = head.lastIndexOf(" ");
  return space > 0 ? head.slice(0, space) : chars.slice(0, max).join("");
}

/**
 * A note name for a saved answer: the question without its quotes, on one line, with what roomsd
 * refuses in a name (control characters, `/`, `\`, `:`, `..`, a leading dot) taken out.
 */
export function noteNameFromQuestion(question: string): string {
  const cleaned = splitQuotes(question)
    .text.normalize("NFC")
    .replace(/[\p{Cc}/\\:]|\.{2,}/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .trim();
  return cutAtWord(cleaned, MAX_QUESTION_NAME).trim() || ANSWER_NOTE;
}

/** The first `count` of `base`, `base (2)`, `base (3)`, … not taken in `notes` (case-insensitively). */
export function freeNoteNames(base: string, notes: readonly Note[], count: number): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < count; i++) {
    const candidate = i === 1 ? base : `${base} (${i})`;
    if (!findNote(notes, candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Creates a note under the first of `names` that is free and returns its file name, or null when
 * every name is taken. Never saves over a note: `create` must refuse a taken name with 409
 * `note_exists` (roomsd's create-only PUT does), and the next name is tried.
 */
export async function createUnderFreeName(names: readonly string[], create: (fileName: string) => Promise<Note>): Promise<string | null> {
  for (const candidate of names) {
    const fileName = noteFileName(candidate);
    try {
      const saved = await create(fileName);
      return saved?.name || fileName;
    } catch (e) {
      if (!(e instanceof RoomsApiError && e.code === "note_exists")) throw e;
    }
  }
  return null;
}

/*
 * One-shot "put the cursor in the body" requests: a freshly created note asks
 * for it, and its view takes it once the body has loaded.
 */
const bodyFocusRequests = new Set<string>();
const focusKey = (date: string, fileName: string) => noteKey(date, noteFileName(fileName));
export function requestNoteBodyFocus(date: string, fileName: string): void {
  bodyFocusRequests.add(focusKey(date, fileName));
}
export function takeNoteBodyFocus(date: string, fileName: string): boolean {
  return bodyFocusRequests.delete(focusKey(date, fileName));
}
