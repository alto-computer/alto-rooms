/*
 * The sidebar's "Plugins" section: one item per enabled plugin that declares a
 * sidebar tab. Click opens its tab (⌘-click a new one); right-click → Turn off.
 */
import { useEffect, useState } from "react";
import { usePlugins, usePluginsStore, useReadOnly, useViewer, useViewerStore } from "@/data/hooks";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { pluginIcon } from "@/plugins/icons";

const ITEM = "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[15px] text-ink";
const ITEM_INTERACTIVE = "hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-ink";

export function PluginItems() {
  const { list } = usePlugins();
  const store = usePluginsStore();
  const readOnly = useReadOnly();
  const { tabs, activeId } = useViewer();
  const viewer = useViewerStore();
  const [menu, setMenu] = useState<{ pluginId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const items = list.filter((p) => store.usable(p) && p.slots.tab?.sidebar);
  if (items.length === 0) return null;
  const active = tabs.find((t) => t.id === activeId);

  return (
    <div className="mt-4 flex flex-col">
      <span className="flex min-h-7 items-center pl-2.5 text-[12px] text-ink-3">Plugins</span>
      <ul aria-label="Plugins" className="flex flex-col gap-0.5 p-0.5">
        {items.map((p) => {
          const Icon = pluginIcon(p.slots.tab!.icon);
          const current = active?.kind === "plugin" && active.pluginId === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-current={current ? "page" : undefined}
                onClick={(e) => viewer.go({ kind: "plugin", pluginId: p.id }, wantsNewTab(e))}
                onAuxClick={(e) => e.button === 1 && viewer.open({ kind: "plugin", pluginId: p.id })}
                onContextMenu={(e) => {
                  if (readOnly) return;
                  e.preventDefault();
                  setMenu({ pluginId: p.id, x: e.clientX, y: e.clientY });
                }}
                className={cn(ITEM, ITEM_INTERACTIVE, current && "bg-[#ebebeb] hover:bg-[#ebebeb]")}
              >
                <Icon size={17} strokeWidth={1.75} aria-hidden className="shrink-0" />
                <span className="truncate">{p.slots.tab!.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {menu ? (
        <div
          role="menu"
          aria-label="Plugin"
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 min-w-[140px] rounded-lg border border-[#ddd] bg-white p-1 text-[14px] shadow-float"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = menu.pluginId;
              setMenu(null);
              void store.setEnabled(id, false);
            }}
            className="w-full rounded-md px-2.5 py-1.5 text-left text-ink hover:bg-[#f2f2f2]"
          >
            Turn off
          </button>
        </div>
      ) : null}
    </div>
  );
}
