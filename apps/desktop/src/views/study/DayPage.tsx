import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SaveStudyDay, StudyDay } from "@alto-rooms/protocol-ts";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { AskBar } from "@/ask/AskBar";
import { useFrameAfter } from "@/ask/useFrameAfter";
import { useClient, useJournalDay, useReadOnly, useRoomsStore, useViewerStore } from "@/data/hooks";
import { localDate } from "@/lib/dates";
import { errorCopy } from "@/lib/errors";
import { addMonths, monthGrid, newId, shortDate, weekdayOf } from "./study";
import { Axes } from "./StudyNav";

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
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(() => {
    client.studyDay(date).then(
      (d) => {
        if (writing.current > 0) return;
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
    writing.current++;
    queue.current = queue.current
      .then(() => client.saveStudyDay(date, { memos: next.memos, todos: next.todos }))
      .catch((e: unknown) => setError(errorCopy(e)))
      .finally(() => writing.current--);
  };

  return { day, error, update };
}

/** Enter outside of an IME composition (Korean input commits its syllable with the same Enter). */
const isSubmit = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229;

/** 달력: one day of the Study, the month around it, and the day's Memo, TODO and Artifacts. */
export function DayPage({ tabId, date }: { tabId: string; date: string }) {
  const viewer = useViewerStore();
  const readOnly = useReadOnly();
  const { day, error, update } = useStudyDay(date);
  const journal = useJournalDay(date);
  const [memo, setMemo] = useState("");
  const [todo, setTodo] = useState("");
  const barReady = useFrameAfter(day !== null);

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
            </div>
            <MonthGrid date={date} onPick={(d) => viewer.replace(tabId, { kind: "study", page: "day", date: d })} />
          </div>

          <section className="st-col" aria-label="Memo">
            <h2 className="st-ch">Memo</h2>
            <input
              className="st-cap"
              placeholder="떠오른 것"
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
                      aria-label={`${m.text} 지우기`}
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
                        aria-label={`${t.text} 지우기`}
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
              placeholder="할 일"
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

const MONTH_LABEL = (month: string) => month.replace("-", ".");

function MonthGrid({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const today = localDate();
  return (
    <div className="st-mini">
      <div className="st-mh">
        <span>{MONTH_LABEL(month)}</span>
        <div>
          <button type="button" aria-label="지난달" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft size={15} strokeWidth={1.5} aria-hidden />
          </button>
          <button type="button" aria-label="다음 달" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight size={15} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>
      <div className="st-grid" aria-label={MONTH_LABEL(month)}>
        {monthGrid(month).map((d) => {
          const cls = [!d.inMonth && "st-out", d.date === today && "st-today", d.date === date && d.date !== today && "st-on"].filter(Boolean).join(" ");
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
