import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { clockTime } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";

/** Something the day holds, as a tally list shows it. */
export type TallyItem = { key: string; title: string; at: string; meta: string; open: (newTab: boolean) => void };

/** One cell of the tally: a noun ("artifact") and that day's items of that kind, in any order. */
export type TallyCell = { noun: string; items: TallyItem[] };

/** How long the pointer may be away from a cell and its list before the list closes, so it can travel from one to the other. */
const HOVER_CLOSE_MS = 150;

const plural = (n: number, noun: string) => (n === 1 ? noun : `${noun}s`);

/**
 * One tally cell: the count, and on hover, focus or click a list of those items, newest first,
 * each opening on click. The list goes below the cell, or above when there is no room below,
 * and scrolls when long. Hover and focus leave the caret where it is; a click (or Enter) moves
 * it into the list.
 */
function Cell({ cell }: { cell: TallyCell }) {
  const [open, setOpen] = useState(false);
  const byClick = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);
  const stay = () => clearTimeout(closing.current);
  const show = (click: boolean) => {
    stay();
    byClick.current = click;
    setOpen(true);
  };
  const leave = () => {
    stay();
    closing.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  const items = [...cell.items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const label = `${items.length} ${plural(items.length, cell.noun)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        onPointerEnter={(e) => e.pointerType === "mouse" && show(false)}
        onPointerLeave={(e) => e.pointerType === "mouse" && leave()}
        onFocus={() => show(false)}
        // Radix toggles on click; a click on a list hover opened keeps it open and moves into it.
        onClick={(e) => {
          if (!open) return;
          e.preventDefault();
          show(true);
          list.current?.querySelector("button")?.focus();
        }}
        className="flex min-w-0 flex-col items-start px-5 pt-3.5 pb-3 text-left outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink data-[state=open]:bg-row-hover"
      >
        <span className="text-title font-medium text-ink tabular-nums">{items.length}</span>
        <span className="text-body text-ink-2">{plural(items.length, cell.noun)}</span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={label}
        onOpenAutoFocus={(e) => {
          if (!byClick.current) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          if (!byClick.current) e.preventDefault();
        }}
        onPointerEnter={stay}
        onPointerLeave={(e) => e.pointerType === "mouse" && leave()}
        className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[300px] flex-col"
      >
        <p className="px-2 pt-1.5 pb-1 text-caption font-semibold text-ink-3">{label}</p>
        {items.length === 0 ? (
          <p className="px-2 pb-2 text-body text-ink-3">None this day</p>
        ) : (
          <ul ref={list} className="min-h-0 overflow-y-auto">
            {items.map((it) => (
              <li key={it.key}>
                <button
                  type="button"
                  onClick={(e) => {
                    setOpen(false);
                    it.open(wantsNewTab(e));
                  }}
                  className="flex w-full min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-strong focus-visible:bg-surface-strong"
                >
                  <span className="w-10 shrink-0 text-small text-ink-3 tabular-nums">{clockTime(it.at)}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-body text-ink">{it.title}</span>
                    {it.meta ? <span className="truncate text-small text-ink-3">{it.meta}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The viewed day at a glance: one cell per kind of thing it holds, side by side. */
export function DayTally({ label, cells }: { label: string; cells: TallyCell[] }) {
  return (
    <section aria-label={label} className="flex flex-col gap-4">
      <h2 className="flex h-7 items-center text-small font-semibold tracking-[0.02em] text-ink-3">{label}</h2>
      <div className="grid auto-cols-fr grid-flow-col overflow-hidden rounded-xl bg-sheet shadow-sheet [&>*+*]:border-l [&>*+*]:border-hairline">
        {cells.map((c) => (
          <Cell key={c.noun} cell={c} />
        ))}
      </div>
    </section>
  );
}
