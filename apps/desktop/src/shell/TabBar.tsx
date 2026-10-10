import { useState, type KeyboardEvent } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { ArrowLeft, ArrowRight, PanelLeft, Plus } from "lucide-react";
import { useViewer, useViewerStore } from "@/data/hooks";
import { IconTip } from "@/components/IconTip";
import { cn } from "@/lib/utils";
import { DRAG_KEYBOARD_CODES } from "./dragKeys";
import { tabDomId } from "./tabIds";
import { TabItem } from "./TabItem";
import { useTabOverflow } from "./useTabOverflow";

const ICON_BUTTON =
  "mb-px grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:pointer-events-none disabled:text-ink-3 disabled:opacity-50";

export function TabBar() {
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();
  const { listRef, fade } = useTabOverflow(activeId, tabs.length);
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a click still switches tabs.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Space picks a tab up, ←/→ move it, Space drops; Enter keeps activating it.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: DRAG_KEYBOARD_CODES }),
  );
  // While a tab is picked up with the keyboard, the arrows move it instead of the focus.
  const [dragging, setDragging] = useState(false);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (!over || active.id === over.id) return;
    viewer.move(String(active.id), tabs.findIndex((t) => t.id === over.id));
  };
  // Chrome's rule: after a close click, tabs keep their width until the pointer leaves the
  // strip, so the next tab's close button lands under the cursor.
  const [frozenWidth, setFrozenWidth] = useState<number | null>(null);

  // ARIA tabs: one Tab stop (the active tab); ←/→/Home/End switch tabs, Delete closes one.
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dragging || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = tabs.findIndex((t) => tabDomId(t.id) === (e.target as HTMLElement).id);
    if (i < 0) return;
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const next = tabs[(to + tabs.length) % tabs.length];
      viewer.activate(next.id);
      document.getElementById(tabDomId(next.id))?.focus();
    } else if (e.key === "Delete") {
      e.preventDefault();
      viewer.close(tabs[i].id);
      const { activeId: now } = viewer.getState();
      requestAnimationFrame(() => now && document.getElementById(tabDomId(now))?.focus());
    }
  };

  return (
    // App chrome: tab labels don't select on drag or double click. The bar sits on the pane, so
    // the active tab meets it with no gap; the buttons centre on the tabs.
    <div className="flex min-w-0 items-end gap-1 px-1 pt-0.5 select-none">
      {sidebarOpen ? null : (
        <IconTip label="Show sidebar" shortcut="⌘B">
          <button type="button" aria-label="Show sidebar (⌘B)" onClick={() => viewer.setSidebarOpen(true)} className={ICON_BUTTON}>
            <PanelLeft size={17} strokeWidth={1.75} aria-hidden />
          </button>
        </IconTip>
      )}
      <IconTip label="Back" shortcut="⌘[">
        <button type="button" aria-label="Back (⌘[)" disabled={!viewer.canGoBack()} onClick={() => viewer.back()} className={ICON_BUTTON}>
          <ArrowLeft size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </IconTip>
      <IconTip label="Forward" shortcut="⌘]">
        <button
          type="button"
          aria-label="Forward (⌘])"
          disabled={!viewer.canGoForward()}
          onClick={() => viewer.forward()}
          className={ICON_BUTTON}
        >
          <ArrowRight size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </IconTip>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Tabs"
        onKeyDown={onListKeyDown}
        onMouseLeave={() => setFrozenWidth(null)}
        // The side padding holds the active tab's inverted corners, which this scroll box would clip;
        // the negative margin takes the bar's gap back so the corners reach the buttons beside it.
        className={cn("-mx-1 flex min-w-0 items-end gap-1 overflow-x-auto px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", fade)}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[horizontalOnly]}
          // Browser style: the tab you pick up is the one you're looking at.
          onDragStart={({ active }) => {
            setDragging(true);
            viewer.activate(String(active.id));
          }}
          onDragCancel={() => setDragging(false)}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                width={frozenWidth}
                onActivate={() => viewer.activate(tab.id)}
                onClose={(width) => {
                  if (width !== undefined) setFrozenWidth(width);
                  viewer.close(tab.id);
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <IconTip label="New tab" shortcut="⌘T">
        <button type="button" aria-label="New tab" onClick={() => viewer.open(viewer.home())} className={ICON_BUTTON}>
          <Plus size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </IconTip>
    </div>
  );
}

/** Tabs only move sideways. */
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });
