import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { CircleAlert, ExternalLink } from "lucide-react";
import { useClient, useJournalDay, useRooms, useRoomsStore } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { openInEditor } from "@/lib/native";
import { createNoteSaver, type NoteSaver, type NoteSaverState } from "@/lib/noteSaver";
import { findNote, noteBase } from "@/lib/notes";

const SAVE_ERROR = "저장하지 못했어요. 다시 시도할게요";

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
 */
export function NoteView({ date, name }: { date: string; name: string }) {
  const base = noteBase(name);
  const client = useClient();
  const store = useRoomsStore();
  const { info } = useRooms();
  const readOnly = info?.readOnly ?? false;
  // Watching the day makes the store refetch it on note.saved/note.removed; no second event stream.
  const day = useJournalDay(date);

  // One saver per mount; dispose() flushes unsaved text. Created in the effect
  // so React's StrictMode remount gets a fresh one.
  const [saver, setSaver] = useState<NoteSaver | null>(null);
  useEffect(() => {
    const s = createNoteSaver({ save: (text) => client.saveNote(date, base, text), warn });
    setSaver(s);
    return () => s.dispose();
  }, [client, date, base]);
  const st = useSaverState(saver);

  // Initial load (and "다시 시도").
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!saver) return;
    let live = true;
    setLoad("loading");
    // The list's updatedAt as of now; a later one means a change after this read.
    const known = findNote(store.getState().days[date]?.notes ?? [], base)?.updatedAt ?? null;
    client.getNote(date, base).then(
      (text) => {
        if (!live) return;
        saver.load(text, known);
        setLoad("ready");
      },
      (err) => {
        if (!live) return;
        if (err instanceof RoomsApiError && err.status === 404) {
          // Not on disk yet (e.g. just created): an empty note.
          saver.load("", known);
          setLoad("ready");
        } else {
          warn("note: failed to load", err);
          setLoad("error");
        }
      },
    );
    return () => {
      live = false;
    };
  }, [saver, attempt, client, store, date, base]);

  // External changes.
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const reloading = useRef(false);
  const remoteUpdatedAt = day ? findNote(day.notes, base)?.updatedAt : undefined;
  useEffect(() => {
    if (!saver || load !== "ready" || !remoteUpdatedAt || focused || reloading.current) return;
    if (st.inFlight || st.text !== st.savedText || !saver.isNewer(remoteUpdatedAt)) return;
    let live = true;
    reloading.current = true;
    client
      .getNote(date, base)
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
  }, [saver, load, remoteUpdatedAt, focused, st, client, date, base]);

  const editable = load === "ready" && !readOnly;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 bg-white px-12 py-10">
      <header className="flex items-center gap-4">
        <h1 className="min-w-0 flex-1 truncate text-[30px] leading-[1.25] font-medium tracking-[-0.01em] text-ink">{base}</h1>
        {readOnly ? null : (
          <button
            type="button"
            disabled={!info}
            onClick={() => {
              if (info) void openInEditor(`${info.home}/journal/${date}/${base}.md`);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[14px] text-ink-2 hover:bg-[#f2f2f2] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <ExternalLink size={15} aria-hidden />
            다른 편집기로 열기
          </button>
        )}
      </header>
      {load === "error" ? (
        <p role="alert" className="flex items-center gap-2 text-[14px] text-[#c13515]">
          <CircleAlert size={16} aria-hidden />
          {GENERIC_ERROR}
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-md px-1.5 text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ink"
          >
            다시 시도
          </button>
        </p>
      ) : null}
      {st.status === "error" ? (
        <p role="status" className="flex items-center gap-2 text-[14px] text-[#c13515]">
          <CircleAlert size={16} aria-hidden />
          {SAVE_ERROR}
        </p>
      ) : null}
      <textarea
        aria-label="노트"
        value={st.text}
        disabled={load !== "ready"}
        readOnly={readOnly}
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
        className="min-h-0 flex-1 resize-none border-0 bg-transparent font-sans text-[16px] leading-[1.7] text-ink outline-none disabled:bg-transparent"
      />
    </div>
  );
}
