/*
 * The sidebar's "Plugins ›" row. Hovering (after a short delay; closing waits a
 * little too, so the pointer can cross over), a click, Enter or → opens a flyout
 * beside it that works like a submenu: the plugins you can open in a tab (click:
 * this tab; ⌘-click: a new one), then "Plugin settings…". ↑/↓ move, Esc or ←
 * go back to the row. Managing plugins lives in Settings › Plugins.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Blocks, Check, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePlugins, useViewer, useViewerStore } from "@/data/hooks";
import { wantsNewTab } from "@/lib/nav";
import { openSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { pluginIcon } from "@/plugins/icons";
import { usable } from "@/plugins/pluginsStore";
import { ICON, ITEM, ITEM_INTERACTIVE } from "./sidebarItem";

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 300;

const MENU_ITEM =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-body text-ink outline-none hover:bg-surface-strong focus-visible:bg-surface-strong";

export function PluginsRow() {
  const { list } = usePlugins();
  const { tabs, activeId } = useViewer();
  const viewer = useViewerStore();
  const [open, setOpen] = useState(false);
  // Opened by a click or a key: focus moves into the flyout, and back to the row when it closes.
  // Opened by hovering: focus stays where it was (a note being typed keeps it).
  const focusInside = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);

  const show = (next: boolean, withFocus: boolean) => {
    cancel();
    if (next) focusInside.current = withFocus;
    setOpen(next);
  };
  const later = (next: boolean, ms: number) => {
    cancel();
    timer.current = setTimeout(() => show(next, false), ms);
  };
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const step = (by: number) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + by + all.length) % all.length]?.focus();
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => void> = {
      ArrowDown: () => step(1),
      ArrowUp: () => step(-1),
      Home: () => items()[0]?.focus(),
      End: () => items().at(-1)?.focus(),
      ArrowLeft: () => show(false, true),
    };
    if (!moves[e.key]) return;
    e.preventDefault();
    moves[e.key]();
  };
  /** Runs a chosen item; where it goes takes the focus, so closing doesn't hand it back to the row. */
  const choose = (run: () => void) => {
    focusInside.current = false;
    show(false, false);
    run();
  };

  const openable = list.filter((p) => usable(p) && p.slots.tab);
  const active = tabs.find((t) => t.id === activeId);
  const current = active?.kind === "plugin" ? active.pluginId : null;
  const hoverLeave = (e: { pointerType: string }) => {
    if (e.pointerType !== "mouse") return;
    // Passing by opens nothing; only a flyout hovering opened closes when the pointer leaves.
    if (!open) cancel();
    else if (!focusInside.current) later(false, CLOSE_DELAY_MS);
  };

  return (
    <Popover open={open} onOpenChange={(next) => show(next, true)}>
      <PopoverTrigger
        aria-haspopup="menu"
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          if (open) cancel();
          else later(true, OPEN_DELAY_MS);
        }}
        onPointerLeave={hoverLeave}
        // Radix toggles on click; a click on a flyout hover opened keeps it open and moves into it.
        onClick={(e) => {
          if (!open || focusInside.current) return;
          e.preventDefault();
          show(true, true);
          items()[0]?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight") return;
          e.preventDefault();
          if (open) items()[0]?.focus();
          show(true, true);
        }}
        className={cn(ITEM, ITEM_INTERACTIVE, "data-[state=open]:bg-row-hover")}
      >
        <Blocks {...ICON} className="shrink-0 text-ink-2" />
        <span className="truncate">Plugins</span>
        <ChevronRight size={14} strokeWidth={1.75} aria-hidden className="ml-auto shrink-0 text-ink-3" />
      </PopoverTrigger>
      <PopoverContent
        ref={menu}
        role="menu"
        aria-label="Plugins"
        side="right"
        // The row sits at the sidebar's foot, so the flyout grows upward from it.
        align="end"
        sideOffset={10}
        alignOffset={-5}
        collisionPadding={8}
        onOpenAutoFocus={(e) => {
          if (!focusInside.current) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          if (!focusInside.current) e.preventDefault();
        }}
        onPointerEnter={cancel}
        onPointerLeave={hoverLeave}
        onKeyDown={onMenuKey}
        className="flex w-auto min-w-52 flex-col"
      >
        {openable.map((p) => {
          const Icon = pluginIcon(p.slots.tab!.icon);
          const here = p.id === current;
          const go = (newTab: boolean) => choose(() => viewer.go({ kind: "plugin", pluginId: p.id }, newTab));
          return (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              aria-current={here ? "page" : undefined}
              onClick={(e) => go(wantsNewTab(e))}
              onAuxClick={(e) => e.button === 1 && go(true)}
              className={MENU_ITEM}
            >
              <Icon size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-2" />
              <span className="truncate">{p.slots.tab!.title}</span>
              {here ? <Check size={14} strokeWidth={1.75} aria-hidden className="ml-auto shrink-0 pl-1 text-ink-2" /> : null}
            </button>
          );
        })}
        {openable.length ? <div role="separator" className="-mx-1 my-1 h-px bg-hairline" /> : null}
        <button type="button" role="menuitem" onClick={() => choose(() => openSettings(viewer, "plugins"))} className={MENU_ITEM}>
          Plugin settings…
        </button>
      </PopoverContent>
    </Popover>
  );
}
