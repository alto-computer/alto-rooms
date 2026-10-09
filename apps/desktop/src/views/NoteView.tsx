import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { CircleAlert, ExternalLink } from "lucide-react";
import { useClient, useJournalDay, useReadOnly, useInfo, useRoomsStore, useViewerStore } from "@/data/hooks";
import { GENERIC_ERROR, noteNameErrorCopy, SAVE_FAILED } from "@/lib/errors";
import { checkNoteDraft, clearNoteDraft, type NoteDraft } from "@/lib/drafts";
import { useBriefError } from "./briefError";
import { EditableTitle } from "./EditableTitle";
import { openInEditor } from "@/lib/native";
import { createNoteSaver, type NoteSaver, type NoteSaverState } from "@/lib/noteSaver";
import {
  attachNoteSaver,
  detachNoteSaver,
  flushNoteSaverAndWait,
  noteSaverKey,
  noteSaverLive,
  renameNoteSaver,
} from "@/lib/noteSaverRegistry";
import { findNote, noteBase, noteFileName, takeNoteBodyFocus } from "@/lib/notes";

const NOT_READY: NoteSaverState = {
  text: "",
  savedText: "",
  inFlight: false,
  dirtyDuringFlight: false,
  failures: 0,
  status: "idle",
  ready: false,
  knownUpdatedAt: null,
};
const noSubscribe = () => () => {};
const notReady = () => NOT_READY;

function useSaverState(saver: NoteSaver | null): NoteSaverState {
  return useSyncExternalStore(saver ? saver.subscribe : noSubscribe, saver ? saver.getState : notReady);
}

const warn = (...args: unknown[]) => console.warn(...args);

/**
 * A note tab: the note's markdown in a plain textarea with autosave (see
 * `noteSaver`). The textarea stays disabled until the body has loaded, so
 * nothing typed into an unloaded note can overwrite it. External changes
 * (the day's note list shows a newer `updatedAt`) reload the body only while
 * there are no unsaved edits and the textarea isn't focused.
 *
 * The heading renames the note in place: the body is saved first (so nothing
 * typed is lost), then the file is renamed, then the live saver and the tab
 * move to the new name. The view re-renders with that name and keeps the saver.
 */
export function NoteView({ tabId, date, name }: { tabId?: string; date: string; name: string }) {
  // `name` is the on-disk file name (e.g. `Plan.md`, `x.md.md`): the API gets it
  // unchanged; one `.md` is stripped only for display.
  const title = noteBase(name);
  const fileName = noteFileName(name);
  const client = useClient();
  const viewer = useViewerStore();
  const store = useRoomsStore();
  const info = useInfo();
  const readOnly = useReadOnly();
  // Watching the day makes the store refetch it on note.saved/note.removed; no second event stream.
  const day = useJournalDay(date);

  // The note's live saver from the registry: reopening a note whose saver is
  // still saving (or retrying) attaches to it instead of reloading from disk.
  // Unmounting detaches; the saver lives on until its text has landed.
  const [saver, setSaver] = useState<NoteSaver | null>(null);
  useEffect(() => {
    const key = noteSaverKey(date, fileName);
    const { saver: s } = attachNoteSaver(key, () => createNoteSaver({ save: (text) => client.saveNote(date, name, text), warn }), {
      date,
      name,
    });
    setSaver(s);
    // Detached a microtask later: on a rename the re-render attaches under the
    // new key first, so the live saver is kept rather than released and reloaded.
    return () => queueMicrotask(() => detachNoteSaver(key, s));
  }, [client, date, name, fileName]);
  const st = useSaverState(saver);

  // Initial load (and "Try again").
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!saver) return;
    if (saver.getState().ready) {
      // Attached to a live saver: its local text is the newest there is.
      setLoad("ready");
      return;
    }
    let live = true;
    setLoad("loading");
    // The list's updatedAt as of now; a later one means a change after this read.
    const known = findNote(store.getState().days[date]?.notes ?? [], name)?.updatedAt ?? null;
    const loaded = (text: string) => {
      saver.load(text, known);
      setLoad("ready");
    };
    client.getNote(date, name).then(
      (text) => {
        if (live) loaded(text);
      },
      (err) => {
        if (!live) return;
        if (err instanceof RoomsApiError && err.status === 404) {
          // Not on disk yet (e.g. just created): an empty note.
          loaded("");
        } else {
          warn("note: failed to load", err);
          setLoad("error");
        }
      },
    );
    return () => {
      live = false;
    };
  }, [saver, attempt, client, store, date, name]);

  // Text that could not be saved before the app last quit was kept as a draft
  // (see checkNoteDraft): restored as unsaved text if the disk hasn't changed
  // since, otherwise offered in a quiet bar. The registry deletes the draft
  // once a save lands.
  const draftChecked = useRef<NoteSaver | null>(null);
  const [offer, setOffer] = useState<NoteDraft | null>(null);
  useEffect(() => {
    if (!saver || load !== "ready" || readOnly || draftChecked.current === saver) return;
    draftChecked.current = saver;
    // Checked once per saver (no cleanup: a StrictMode re-run must not drop the answer).
    void checkNoteDraft(saver, date, name).then((r) => {
      if (r.kind === "conflict" && draftChecked.current === saver) setOffer(r.draft);
    });
  }, [saver, load, readOnly, date, name]);

  // External changes.
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const reloading = useRef(false);
  const remoteUpdatedAt = day ? findNote(day.notes, name)?.updatedAt : undefined;
  useEffect(() => {
    if (!saver || load !== "ready" || !remoteUpdatedAt || focused || reloading.current) return;
    if (st.inFlight || st.text !== st.savedText || !saver.isNewer(remoteUpdatedAt)) return;
    let live = true;
    reloading.current = true;
    client
      .getNote(date, name)
      .then(
        (text) => {
          if (live && !focusedRef.current) saver.applyRemote(text, remoteUpdatedAt);
        },
        (err) => warn("note: failed to reload after an external change", err),
      )
      .finally(() => {
        reloading.current = false;
      });
    return () => {
      live = false;
    };
  }, [saver, load, remoteUpdatedAt, focused, st, client, date, name]);

  // A new note asks for the cursor in its body once it has loaded.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (load === "ready" && !readOnly && takeNoteBodyFocus(date, name)) textareaRef.current?.focus();
  }, [load, readOnly, date, name]);

  const [renaming, setRenaming] = useState(false);
  const rename = async (next: string) => {
    const key = noteSaverKey(date, fileName);
    setRenaming(true);
    try {
      // Never lose body text: whatever is typed or in flight lands under the old name first.
      if (!(await flushNoteSaverAndWait(key))) throw new RoomsApiError(500, "note body not saved", "write_failed");
      // Another live saver under the new name (unsaved text for a file that vanished):
      // refuse rather than overwrite it, before anything moves on disk.
      const toKey = noteSaverKey(date, noteFileName(next));
      if (toKey !== key && noteSaverLive(toKey)) throw new Error("note: a live saver holds the new name");
      const renamed = await client.renameNote(date, name, next);
      const to = renamed?.name || noteFileName(next);
      if (!renameNoteSaver(key, noteSaverKey(date, to), { date, name: to }, (d, n, text) => client.saveNote(d, n, text))) {
        throw new Error("note: a live saver holds the new name");
      }
      // The body landed under the old name and moved with the file: a draft kept under that name is stale.
      setOffer(null);
      void clearNoteDraft(date, name);
      const id = tabId ?? viewer.getState().tabs.find((t) => t.kind === "note" && t.date === date && t.name === name)?.id;
      if (id) viewer.replace(id, { kind: "note", date, name: to });
    } finally {
      setRenaming(false);
    }
  };

  const editable = load === "ready" && !readOnly && !renaming;
  const openFailed = useBriefError();
  const openElsewhere = (absPath: string) => {
    openInEditor(absPath).then(openFailed.clear, (err) => {
      warn("note: could not open in another editor", err);
      openFailed.flash();
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 bg-pane px-12 py-10">
      <header className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <EditableTitle
            value={title}
            onSave={rename}
            copyError={noteNameErrorCopy}
            ariaLabel="Note name"
            readOnly={readOnly}
            className="w-full truncate text-display leading-[1.25] font-medium tracking-[-0.01em] text-ink"
          />
        </div>
        {readOnly ? null : (
          <button
            type="button"
            disabled={!info}
            onClick={() => {
              if (info) openElsewhere(`${info.home}/journal/${date}/${fileName}`);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-body text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <ExternalLink size={15} aria-hidden />
            Open in another editor
          </button>
        )}
      </header>
      {load === "error" ? (
        <p role="alert" className="flex items-center gap-2 text-body text-error">
          <CircleAlert size={16} aria-hidden />
          {GENERIC_ERROR}
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-md px-1.5 text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ink"
          >
            Try again
          </button>
        </p>
      ) : null}
      {openFailed.shown ? (
        <p role="status" className="flex items-center gap-2 text-body text-error">
          <CircleAlert size={16} aria-hidden />
          {GENERIC_ERROR}
        </p>
      ) : null}
      {offer ? (
        <p role="status" className="flex items-center gap-3 text-body text-ink-2">
          You have unsaved text
          <button
            type="button"
            onClick={() => {
              saver?.edit(offer.text);
              setOffer(null);
            }}
            className="rounded-md px-1.5 text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ink"
          >
            Restore
          </button>
          <button
            type="button"
            onClick={() => {
              setOffer(null);
              void clearNoteDraft(date, name);
            }}
            className="rounded-md px-1.5 text-ink-2 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ink"
          >
            Discard
          </button>
        </p>
      ) : null}
      {st.status === "error" ? (
        <p role="status" className="flex items-center gap-2 text-body text-error">
          <CircleAlert size={16} aria-hidden />
          {SAVE_FAILED}
        </p>
      ) : null}
      <textarea
        aria-label="Note"
        data-note-editor=""
        ref={textareaRef}
        value={st.text}
        disabled={load !== "ready"}
        readOnly={readOnly || renaming}
        onChange={(e) => {
          if (editable) saver?.edit(e.target.value);
        }}
        onFocus={() => {
          focusedRef.current = true;
          setFocused(true);
        }}
        onBlur={() => {
          focusedRef.current = false;
          setFocused(false);
          if (editable) saver?.blur();
        }}
        className="min-h-0 flex-1 resize-none border-0 bg-transparent font-sans text-lead leading-[1.7] text-ink outline-none disabled:bg-transparent"
      />
    </div>
  );
}
