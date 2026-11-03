import { useState, type MouseEvent, type ReactNode } from "react";
import type { StudyDayBookSummary } from "@alto-rooms/protocol-ts";
import { localDate } from "@/lib/dates";
import { useDayBooks } from "./dayBooks";
import { clothOf, shortDate, weekdayOf } from "./study";
import { Axes, useStudyGo } from "./StudyNav";

/** Books one board holds; a month with more takes the next board down too. */
const BOOKS_PER_BOARD = 10;
/** The wall always shows at least this many boards, so an empty shelf still looks like shelving. */
const MIN_BOARDS = 4;
const BOARD_HEIGHT = 230;
/** Spine widths and heights, cycled by day so a shelf never looks stamped out (as on the library wall). */
const WIDTHS = [30, 34, 28, 36, 32, 33];
const HEIGHTS = [150, 160, 142, 166, 154, 146];

const two = (n: number) => String(n).padStart(2, "0");
const monthLabel = (month: string) => month.replace("-", ".");

/** A spine on the shelf: a listed book, or today's, which is there even before it holds anything. */
type Spine = { date: string; title: string };
type Board = { month: string; first: boolean; spines: Spine[] };

/**
 * The boards, newest month on top: each month's books oldest to newest, today's among them, cut into
 * boards of `BOOKS_PER_BOARD`.
 */
function boardsOf(books: StudyDayBookSummary[], today: string): Board[] {
  const spines: Spine[] = books.some((b) => b.date === today) ? [...books] : [...books, { date: today, title: "" }];
  const months = new Map<string, Spine[]>();
  for (const s of spines.sort((a, b) => a.date.localeCompare(b.date))) {
    const month = s.date.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), s]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .flatMap(([month, all]) =>
      Array.from({ length: Math.ceil(all.length / BOOKS_PER_BOARD) }, (_, i) => ({ month, first: i === 0, spines: all.slice(i * BOOKS_PER_BOARD, (i + 1) * BOOKS_PER_BOARD) })),
    );
}

/** 날짜 서재: the day books on a wall, a board a month, today's leaning as a proof. */
export function ShelfPage() {
  const books = useDayBooks();
  const today = localDate();
  const [hovered, setHovered] = useState<Spine | null>(null);
  const boards = books ? boardsOf(books, today) : [];
  const rows = Math.max(MIN_BOARDS, boards.length);

  return (
    <>
      <Axes on="day" />
      <div className="st-scroll">
        <div className="st-lib">
          <Lede spine={hovered} count={books?.length ?? null} />
          <div className="st-wall st-shelf" style={{ height: rows * BOARD_HEIGHT + 10 }}>
            <div className="st-rail" style={{ left: 0 }} />
            <div className="st-rail" style={{ left: "100%" }} />
            <div className="st-cells" role="list" aria-label="Shelf">
              {boards.map((b) => (
                <div key={`${b.month}:${b.spines[0].date}`} role="listitem" className="st-cell">
                  <div className="st-row">
                    {b.spines.map((s) => (
                      <SpineButton key={s.date} spine={s} proof={s.date === today} onHover={(on) => setHovered(on ? s : null)} />
                    ))}
                    <div className="st-end" />
                  </div>
                  <div className="st-board" />
                  {b.first ? <div className="st-label">{monthLabel(b.month)}</div> : null}
                </div>
              ))}
              {Array.from({ length: rows - boards.length }, (_, i) => (
                <div key={i} className="st-cell" aria-hidden>
                  <div className="st-board" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Lede({ spine, count }: { spine: Spine | null; count: number | null }) {
  let body: ReactNode = null;
  if (spine) {
    body = (
      <>
        <div className="st-kick">{weekdayOf(spine.date)}</div>
        <div className="st-big">{shortDate(spine.date)}</div>
        {spine.title ? <div className="st-sub">{spine.title}</div> : null}
      </>
    );
  } else if (count !== null) {
    body = (
      <>
        <div className="st-big">{two(count)}</div>
        <div className="st-sub">{count === 1 ? "book" : "books"}</div>
      </>
    );
  }
  return (
    <div className="st-lede" aria-live="polite">
      <div key={spine?.date ?? "count"} className="st-swap">
        {body}
      </div>
    </div>
  );
}

function SpineButton({ spine, proof, onHover }: { spine: Spine; proof: boolean; onHover: (on: boolean) => void }) {
  const go = useStudyGo();
  const day = Number(spine.date.slice(8));
  const size = day % WIDTHS.length;
  const common = {
    type: "button" as const,
    "aria-label": `Book · ${spine.date.replaceAll("-", ".")}`,
    "data-cloth": clothOf(spine.date),
    onClick: (e: MouseEvent) => go({ page: "book", date: spine.date }, e),
    onMouseEnter: () => onHover(true),
    onMouseLeave: () => onHover(false),
    onFocus: () => onHover(true),
    onBlur: () => onHover(false),
  };
  if (proof) {
    return (
      <button {...common} className="st-bk st-proof" style={{ width: 30, height: HEIGHTS[size] - 14 }}>
        <span className="st-spine">{spine.title}</span>
        <span className="st-no">{day}</span>
        <span className="st-rib" />
      </button>
    );
  }
  return (
    <button {...common} className="st-bk" style={{ width: WIDTHS[size], height: HEIGHTS[size] }}>
      <span className="st-foil" />
      <span className="st-spine">{spine.title}</span>
      <span className="st-no">{day}</span>
    </button>
  );
}
