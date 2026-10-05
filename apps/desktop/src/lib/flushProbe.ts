/*
 * Verification hook for the quit flush (see `flush_probe` in src-tauri/flush.rs).
 *
 * Inert unless the app was launched with ALTO_ROOMS_FLUSH_PROBE=<date>/<note>.
 * Then it loads that note into a registered saver whose clock never fires, and
 * edits it: the edit can reach disk only through a quit flush, which is what a
 * bundle check of "quit → flush → exit" needs to observe without typing.
 */
import { invoke } from "@tauri-apps/api/core";
import { attachNoteSaver, createNoteSaver, noteSaverKey, type SaveNoteFn } from "./noteSaver";

const never = { setTimeout: () => 0, clearTimeout: () => {} };

export async function runFlushProbe(getNote: (date: string, name: string) => Promise<string>, saveNote: SaveNoteFn): Promise<void> {
  const probe = await invoke<{ date: string; name: string } | null>("flush_probe");
  if (!probe) return;
  const { date, name } = probe;
  const { saver } = attachNoteSaver(
    noteSaverKey(date, name),
    () => createNoteSaver({ save: (text) => saveNote(date, name, text), clock: never }),
    { date, name },
  );
  const body = await getNote(date, name).catch(() => "");
  saver.load(body, null);
  saver.edit(`${body}\nflushed at quit ${new Date().toISOString()}\n`);
  await invoke("flush_probe_armed");
}
