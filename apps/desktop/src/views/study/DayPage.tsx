import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveStudyDay, StudyDay } from "@alto-rooms/protocol-ts";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { AskBar } from "@/ask/AskBar";
import { useFrameAfter } from "@/ask/useFrameAfter";
import { useClient, useJournalDay, useReadOnly, useRoomsStore, useViewerStore } from "@/data/hooks";
import { localDate } from "@/lib/dates";
import { errorCopy } from "@/lib/errors";
import { useDayBooks } from "./dayBooks";
import { addMonths, clothOf, isSubmit, monthGrid, newId, shortDate, weekdayOf } from "./study";
import { Axes, useStudyGo } from "./StudyNav";

/**
 * A Study day, kept here while it is shown: loaded on arrival and again when roomsd says the Study
 * changed (unless a write of ours is still on its way). Each change shows at once and is saved whole;
 * saves go out one after another, so the last change is the one on disk.
 */
function useStudyDay(date: string) {
  const client = useClient();
  const rooms = useRoomsStore();
  const [day, setDay] = useState<StudyDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<StudyDay | null>(null);
  const writing = useRef(0);
  /** Changes made so far: a load that started before the latest one is older than the screen. */
  const edits = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(() => {
    const asOf = edits.current;
    client.studyDay(date).then(
      (d) => {
        if (writing.current > 0 || edits.current !== asOf) return;
        current.current = d;
        setDay(d);
      },
      (e: unknown) => setError(errorCopy(e)),
    );
  }, [client, date]);

  useEffect(() => {
    load();
    return rooms.onSignal((type, e) => {
      if ((type === "study.changed" && e.type === "study.changed" && e.roomId === null) || type === "resync") load();
    });
  }, [load, rooms]);

  const update = (change: (d: StudyDay) => SaveStudyDay) => {
    const base = current.current;
    if (!base) return;
    const next = { ...base, ...change(base) };
    current.current = next;
    setDay(next);
    setError(null);
    edits.current++;
    writing.current++;
    queue.current = queue.current
      .then(() => client.saveStudyDay(date, { memos: next.memos, todos: next.todos }))
      .catch((e: unknown) => setError(errorCopy(e)))
      .finally(() => writing.current--);
  };

  return { day, error, update };
}

/** 달력: one day of the Study, the month around it, and the day's Memo, TODO and Artifacts. */
export function DayPage({ tabId, date }: { tabId: string; date: string }) {
  const viewer = useViewerStore();
  const readOnly = useReadOnly();
  const { day, error, update } = useStudyDay(date);
  const journal = useJournalDay(date);
  const [memo, setMemo] = useState("");
  const [todo, setTodo] = useState("");
  const barReady = useFrameAfter(day !== null);
  const books = useDayBooks();
  const booked = new Set(books?.map((b) => b.date));

  const at = () => new Date().toISOString();
  const addMemo = () => {
    const text = memo.trim();
    if (!text) return;
    update((d) => ({ memos: [...d.memos, { id: newId(), text, at: at() }], todos: d.todos }));
    setMemo("");
  };
  const addTodo = () => {
    const text = todo.trim();
    if (!text) return;
    update((d) => ({ memos: d.memos, todos: [...d.todos, { id: newId(), text, done: false, at: at() }] }));
    setTodo("");
  };
  const artifacts = [...(journal?.artifacts ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Axes on="day" />
      <div className="st-scroll">
        <div className="st-day">
          <div className="st-lede">
            <div>
              <div className="st-kick">{weekdayOf(date)}</div>
              <h1 className="st-big">{shortDate(date)}</h1>
              <Cover date={date} title={books?.find((b) => b.date === date)?.title ?? null} />
            </div>
            <MonthGrid date={date} booked={booked} onPick={(d) => viewer.replace(tabId, { kind: "study", page: "day", date: d })} />
          </div>

          <section className="st-col" aria-label="Memo">
            <h2 className="st-ch">Memo</h2>
            <input
              className="st-cap"
              placeholder="New memo"
              aria-label="Memo"
              value={memo}
              disabled={readOnly || !day}
              onChange={(e) => setMemo(e.target.value)}
              onKeyDown={(e) => isSubmit(e) && addMemo()}
            />
            <ul>
              {[...(day?.memos ?? [])].reverse().map((m) => (
                <li key={m.id} className="st-memo">
                  <p>{m.text}</p>
                  {readOnly ? null : (
                    <button
                      type="button"
                      className="st-x"
                      aria-label={`Delete ${m.text}`}
                      onClick={() => update((d) => ({ memos: d.memos.filter((x) => x.id !== m.id), todos: d.todos }))}
                    >
                      <X size={13} strokeWidth={1.5} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="st-col" aria-label="TODO">
            <h2 className="st-ch">TODO</h2>
            <ul className="st-todos">
              {(day?.todos ?? []).map((t) => (
                <li key={t.id}>
                  <label className={t.done ? "st-todo st-done" : "st-todo"}>
                    <input
                      type="checkbox"
                      checked={t.done}
                      disabled={readOnly}
                      onChange={() => update((d) => ({ memos: d.memos, todos: d.todos.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) }))}
                    />
                    <span>{t.text}</span>
                    {readOnly ? null : (
                      <button
                        type="button"
                        className="st-x"
                        aria-label={`Delete ${t.text}`}
                        onClick={(e) => {
                          e.preventDefault();
                          update((d) => ({ memos: d.memos, todos: d.todos.filter((x) => x.id !== t.id) }));
                        }}
                      >
                        <X size={13} strokeWidth={1.5} aria-hidden />
                      </button>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            <input
              className="st-cap"
              placeholder="New TODO"
              aria-label="TODO"
              value={todo}
              disabled={readOnly || !day}
              onChange={(e) => setTodo(e.target.value)}
              onKeyDown={(e) => isSubmit(e) && addTodo()}
            />
          </section>

          <section className="st-col" aria-label="Artifacts">
            <h2 className="st-ch">Artifacts</h2>
            <ul>
              {artifacts.map((a) => (
                <li key={`${a.roomId}/${a.id}`}>
                  <button
                    type="button"
                    className="st-af"
                    onClick={() => viewer.open({ kind: "artifact", roomId: a.roomId, artifactId: a.id }, { nextToActive: true })}
                  >
                    <span className="st-th" aria-hidden />
                    <span>{a.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {error ? (
            <p role="alert" className="col-span-full mt-6 text-small text-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      {barReady && !readOnly ? <AskBar subject={{ kind: "day", date }} /> : null}
    </div>
  );
}

/** The day's book as its cover: the date and the title. `title` is null while the book is empty or unknown. */
function Cover({ date, title }: { date: string; title: string | null }) {
  const go = useStudyGo();
  return (
    <button
      type="button"
      className={title === null ? "st-cover st-blank" : "st-cover"}
      data-cloth={clothOf(date)}
      aria-label={`Book · ${shortDate(date)}`}
      onClick={(e) => go({ page: "book", date }, e)}
    >
      <span className="st-cd">{shortDate(date)}</span>
      {title ? <span className="st-ct">{title}</span> : null}
      <span className="st-cr" />
    </button>
  );
}

const MONTH_LABEL = (month: string) => month.replace("-", ".");

/** The month around the day: a day with a book is marked, and the month's name opens the shelf. */
function MonthGrid({ date, booked, onPick }: { date: string; booked: Set<string>; onPick: (date: string) => void }) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const today = localDate();
  const go = useStudyGo();
  return (
    <div className="st-mini">
      <div className="st-mh">
        <button type="button" className="st-mlabel" onClick={(e) => go({ page: "shelf" }, e)}>
          {MONTH_LABEL(month)}
        </button>
        <div>
          <button type="button" aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft size={15} strokeWidth={1.5} aria-hidden />
          </button>
          <button type="button" aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight size={15} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>
      <div className="st-grid" aria-label={MONTH_LABEL(month)}>
        {monthGrid(month).map((d) => {
          const cls = [!d.inMonth && "st-out", d.date === today && "st-today", d.date === date && d.date !== today && "st-on", booked.has(d.date) && "st-has"].filter(Boolean).join(" ");
          return (
            <button
              key={d.date}
              type="button"
              className={cls || undefined}
              aria-label={d.date}
              aria-current={d.date === date ? "date" : undefined}
              onClick={() => onPick(d.date)}
            >
              {Number(d.date.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
