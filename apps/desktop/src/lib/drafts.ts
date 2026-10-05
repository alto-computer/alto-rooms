/*
 * Where note drafts live: notes that could not be saved before the app quit.
 *
 * - In Tauri, through Rust (`save_note_draft` / `load_note_draft` /
 *   `delete_note_draft`): one 0600 file per draft under the app data dir,
 *   fsynced before the command returns, so it survives the exit that follows.
 * - In a plain browser (dev, e2e), localStorage.
 *
 * A draft holds the note text and a hash of the disk body the saver last knew
 * (`baseHash`), never a token.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

export type NoteDraft = { text: string; baseHash: string | null };

export type DraftStore = {
  save(key: string, value: string): Promise<void>;
  load(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
};

export const tauriDraftStore: DraftStore = {
  save: async (key, value) => {
    await invoke("save_note_draft", { key, value });
  },
  load: async (key) => (await invoke<string | null>("load_note_draft", { key })) ?? null,
  remove: async (key) => {
    await invoke("delete_note_draft", { key });
  },
};

export const localDraftStore: DraftStore = {
  save: async (key, value) => localStorage.setItem(key, value),
  load: async (key) => localStorage.getItem(key),
  remove: async (key) => localStorage.removeItem(key),
};

let override: DraftStore | null = null;

/** Tests: replaces the store (null restores the default). */
export function setDraftStoreForTests(store: DraftStore | null): void {
  override = store;
}

export function draftStore(): DraftStore {
  return override ?? (isTauri() ? tauriDraftStore : localDraftStore);
}

/** A short, stable hash of a note body (53-bit, cyrb53), as hex. */
export function textHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function encodeDraft(d: NoteDraft): string {
  return JSON.stringify({ v: 1, text: d.text, baseHash: d.baseHash });
}

/** Parses a stored draft; anything unreadable counts as text with an unknown base. */
export function decodeDraft(raw: string): NoteDraft {
  try {
    const d = JSON.parse(raw) as { v?: number; text?: unknown; baseHash?: unknown };
    if (d && d.v === 1 && typeof d.text === "string") {
      return { text: d.text, baseHash: typeof d.baseHash === "string" ? d.baseHash : null };
    }
  } catch {
    // not JSON: an older plain-text draft
  }
  return { text: raw, baseHash: null };
}
