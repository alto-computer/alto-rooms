/*
 * Verification hook for the quit flush (see `flush_probe` in src-tauri/flush.rs).
 *
 * Compiled in only for verification builds (Vite define __FLUSH_PROBE__, set by
 * ALTO_FLUSH_PROBE=1, with the Rust feature `flush-probe`); absent otherwise.
 * Inert unless the app was launched with ALTO_ROOMS_FLUSH_PROBE=<date>/<note>.
 * Then it waits (up to 60 s) for that note to exist (created through roomsd's
 * API by whoever runs the check), loads it into a registered saver whose clock
 * never fires, and edits it (or, if a draft from the last quit exists,
 * restores and saves that instead): the edit can reach disk only through a quit flush, which is what a
 * bundle check of "quit → flush → exit" needs to observe without typing.
 */
import { invoke } from "@tauri-apps/api/core";
import { attachNoteSaver, checkNoteDraft, createNoteSaver, noteSaverKey, type SaveNoteFn } from "./noteSaver";

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
  let body: string | null = null;
  for (let i = 0; i < 240 && body === null; i++) {
    body = await getNote(date, name).catch(() => null);
    if (body === null) await new Promise((r) => setTimeout(r, 250));
  }
  if (body === null) {
    console.error("flush probe: the note never appeared");
    return;
  }
  saver.load(body, null);
  // A draft kept at the last quit: restore it the way a note view would, and save it now.
  const draft = await checkNoteDraft(saver, date, name);
  if (draft.kind !== "none") {
    if (draft.kind === "restored") saver.flush();
    await invoke("flush_probe_armed", { state: `draft ${draft.kind}` });
    return;
  }
  saver.edit(`${body}\nflushed at quit ${new Date().toISOString()}\n`);
  await invoke("flush_probe_armed", { state: "note is dirty; only a quit flush can save it" });
}
