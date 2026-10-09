import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquareQuote } from "lucide-react";
import type { SelectionRect } from "./useTextSelection";

/** One button in the bar. Core's Ask comes first; plugins add theirs after it. */
export type SelectionAction = { key: string; title: string; color?: string; icon?: ReactNode; run: () => void };

/** Room the bar needs above the selection; with less, it goes below. */
const ABOVE_PX = 40;
const EDGE_PX = 8;

/** Ask, as in Claude: it puts the selected text in the ask bar as a quote. */
export const askAction = (run: () => void): SelectionAction => ({
  key: "ask",
  title: "Ask",
  icon: <MessageSquareQuote className="size-3.5" aria-hidden />,
  run,
});

const PILL = "pointer-events-auto absolute z-20 flex h-8 -translate-x-1/2 items-center rounded-full border border-[#dcdcdc] bg-white text-[12.5px] font-medium text-ink shadow-[0_4px_14px_rgba(0,0,0,0.12)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95";
const ITEM = "flex items-center gap-1.5 hover:bg-[#f7f7f7] focus-visible:outline-2 focus-visible:outline-ink";

function Label({ action }: { action: SelectionAction }) {
  return (
    <>
      {action.icon ?? (action.color ? <span aria-hidden className="size-3 shrink-0 rounded-full border border-black/10" style={{ background: action.color }} /> : null)}
      {action.title}
    </>
  );
}

/**
 * The floating bar over selected text. `onMouseDown` is prevented so a click doesn't clear the
 * selection first. A lone action is one pill button; more share a pill. The bar stays centered
 * over the selection unless that would push it past the box's sides.
 */
export function SelectionBar({ rect, actions }: { rect: SelectionRect; actions: SelectionAction[] }) {
  const root = useRef<HTMLElement | null>(null);
  const [nudge, setNudge] = useState(0);
  const below = rect.y < ABOVE_PX;
  const center = Math.max(EDGE_PX, rect.x + rect.w / 2);
  useLayoutEffect(() => {
    const el = root.current;
    const width = el?.offsetWidth ?? 0;
    const room = (el?.offsetParent as HTMLElement | null)?.clientWidth ?? 0;
    if (!width || !room) return setNudge(0);
    const lo = EDGE_PX + width / 2;
    const hi = room - EDGE_PX - width / 2;
    setNudge(hi < lo ? 0 : Math.min(Math.max(center, lo), hi) - center);
  }, [center, actions.length]);
  if (actions.length === 0) return null;
  const style = { left: center + nudge, top: below ? rect.y + rect.h + 8 : rect.y - 8 };
  const place = below ? "" : "-translate-y-full";
  if (actions.length === 1) {
    const [a] = actions;
    return (
      <button
        ref={(el) => void (root.current = el)}
        type="button"
        data-selection-ask
        onMouseDown={(e) => e.preventDefault()}
        onClick={a.run}
        style={style}
        className={`${PILL} ${ITEM} gap-1.5 px-3 ${place}`}
      >
        <Label action={a} />
      </button>
    );
  }
  return (
    <div
      ref={(el) => void (root.current = el)}
      role="toolbar"
      aria-label="Selection actions"
      data-selection-ask
      onMouseDown={(e) => e.preventDefault()}
      style={style}
      className={`${PILL} overflow-hidden whitespace-nowrap ${place}`}
    >
      {actions.map((a, i) => (
        <button key={a.key} type="button" onClick={a.run} className={`${ITEM} h-full px-3 ${i > 0 ? "border-l border-[#ececec]" : ""}`}>
          <Label action={a} />
        </button>
      ))}
    </div>
  );
}
