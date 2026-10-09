import { PeekGlyph } from "@/components/PeekGlyph";
import { useViewerStore } from "@/data/hooks";
import { wantsNewTab } from "@/lib/nav";

/** The brand row: goes home, today's Journal, in this tab (⌘-click: a new one). */
export function BrandRow() {
  const viewer = useViewerStore();
  return (
    <button
      type="button"
      onClick={(e) => viewer.go(viewer.home(), wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && viewer.go(viewer.home(), true)}
      className="group flex h-8 min-w-0 items-center gap-[7px] rounded-lg pr-2 pl-1.5 text-ink outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-ink"
    >
      <PeekGlyph size={24} className="size-[22px] shrink-0 origin-[50%_80%] transition-transform duration-300 ease-out group-hover:-rotate-8" />
      <span className="font-display text-heading font-medium tracking-[-0.005em]">Rooms</span>
    </button>
  );
}
