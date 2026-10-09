import { MessageSquareQuote } from "lucide-react";

/** Where the selection is, in px from the top-left of the box the button is placed in. */
export type SelectionRect = { x: number; y: number; w: number; h: number };

/** Room the button needs above the selection; with less, it goes below. */
const ABOVE_PX = 40;

/**
 * The small "Ask" button over selected text, as in Claude: it puts the text in the ask bar as a quote.
 * `onMouseDown` is prevented so clicking it doesn't clear the selection first.
 */
export function SelectionAsk({ rect, onAsk }: { rect: SelectionRect; onAsk: () => void }) {
  const below = rect.y < ABOVE_PX;
  return (
    <button
      type="button"
      data-selection-ask
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAsk}
      style={{ left: Math.max(8, rect.x + rect.w / 2), top: below ? rect.y + rect.h + 8 : rect.y - 8 }}
      className={`pointer-events-auto absolute z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[#dcdcdc] bg-white px-3 text-[12.5px] font-medium text-ink shadow-[0_4px_14px_rgba(0,0,0,0.12)] hover:bg-[#f7f7f7] focus-visible:outline-2 focus-visible:outline-ink motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 ${below ? "" : "-translate-y-full"}`}
    >
      <MessageSquareQuote className="size-3.5" aria-hidden />
      Ask
    </button>
  );
}

/** The bridge's message from a doc frame: `{roomsSelection: 1, text, rect}`. Anything else is null. */
export function readSelectionMessage(data: unknown): { text: string; rect: SelectionRect | null } | null {
  if (!data || typeof data !== "object" || (data as { roomsSelection?: unknown }).roomsSelection !== 1) return null;
  const { text, rect } = data as { text?: unknown; rect?: unknown };
  if (typeof text !== "string") return null;
  const r = rect as Partial<Record<keyof SelectionRect, unknown>> | null;
  const ok = r && (["x", "y", "w", "h"] as const).every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
  return { text: text.slice(0, 4000), rect: ok ? (r as SelectionRect) : null };
}
