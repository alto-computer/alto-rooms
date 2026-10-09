import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./tauri";

/** Where to create a TypeSafe key. */
export const KEY_CONSOLE_URL = "https://console.typesafe.ai/keys";

/** `<data>/sort-status.json`, as rooms-sort last wrote it. */
export interface SortStatus {
  lastRunAt: string;
  movedToday: number;
  keptToday: number;
  lastRun: { considered: number; moved: number; kept: number; roomsCreated: number };
  keyRejected: boolean;
  error: string | null;
}

export interface SortState {
  /** `env` = TYPESAFE_API_KEY in the app's environment (wins over the Keychain). */
  keySource: "none" | "env" | "keychain";
  /** TypeSafe refused the key in use; only R1 and R2 run. */
  keyRejected: boolean;
  status: SortStatus | null;
}

/** Without Tauri (the browser dev build) there is no sorter: null. */
export async function sortState(): Promise<SortState | null> {
  return isTauri() ? invoke<SortState>("sort_state") : null;
}

/** Checks the key with TypeSafe and keeps it in the Keychain; rejects with a message to show. */
export async function sortSetKey(key: string): Promise<void> {
  await invoke("sort_set_key", { key });
}

export async function sortClearKey(): Promise<void> {
  await invoke("sort_clear_key");
}

/** Moves the last run's documents back to the inbox; resolves to rooms-sort's report lines. */
export async function sortUndoLast(): Promise<string[]> {
  return invoke<string[]>("sort_undo_last");
}

export async function openKeyConsole(): Promise<void> {
  if (isTauri()) await openUrl(KEY_CONSOLE_URL);
  else window.open(KEY_CONSOLE_URL, "_blank", "noopener");
}

/** "2 min ago" style age of an ISO time. */
export function ago(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
