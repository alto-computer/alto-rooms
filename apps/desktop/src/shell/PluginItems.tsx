/*
 * The sidebar's "Plugins" section: every plugin the user has approved. A running
 * plugin with a sidebar tab opens it on click (⌘-click: a new tab); a turned-off
 * plugin shows dimmed with "Off". Right-click turns a plugin off or back on.
 */
import { useEffect, useState, type MouseEvent } from "react";
import { usePlugins, usePluginsStore, useReadOnly, useViewer, useViewerStore } from "@/data/hooks";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { pluginIcon } from "@/plugins/icons";
import { ITEM, ITEM_INTERACTIVE } from "./sidebarItem";

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

  // Approved before, runnable here, and not waiting to approve more (that's the enable card's job).
  const items = list.filter((p) => p.status === "ok" && p.compatible && p.granted !== null && !p.needsApproval);
  if (items.length === 0) return null;
  const active = tabs.find((t) => t.id === activeId);

  return (
    <div className="mt-4 flex flex-col">
      <span className="flex min-h-7 items-center pl-2.5 text-[12px] text-ink-3">Plugins</span>
      <ul aria-label="Plugins" className="flex flex-col gap-0.5 p-0.5">
        {items.map((p) => {
          const Icon = pluginIcon(p.slots.tab?.icon);
          const current = active?.kind === "plugin" && active.pluginId === p.id;
          const opens = p.enabled && p.slots.tab;
          const onContextMenu = (e: MouseEvent) => {
            if (readOnly) return;
            e.preventDefault();
            setMenu({ pluginId: p.id, x: e.clientX, y: e.clientY });
          };
          return (
            <li key={p.id}>
              {opens ? (
                <button
                  type="button"
                  aria-current={current ? "page" : undefined}
                  onClick={(e) => viewer.go({ kind: "plugin", pluginId: p.id }, wantsNewTab(e))}
                  onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "plugin", pluginId: p.id }, true)}
                  onContextMenu={onContextMenu}
                  className={cn(ITEM, ITEM_INTERACTIVE, current && "bg-[#ebebeb] hover:bg-[#ebebeb]")}
                >
                  <Icon size={17} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="truncate">{p.slots.tab!.title}</span>
                </button>
              ) : (
                <div
                  onContextMenu={onContextMenu}
                  title={p.enabled && p.slots.artifactSidePanel ? `Opens beside documents: ${p.slots.artifactSidePanel.title}` : undefined}
                  className={cn(ITEM, !p.enabled && "text-ink-3")}
                >
                  <Icon size={17} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="truncate">{p.slots.tab?.title ?? p.name}</span>
                  {p.enabled ? null : <span className="ml-auto shrink-0 text-[12px]">Off</span>}
                </div>
              )}
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
          {(() => {
            const p = list.find((x) => x.id === menu.pluginId);
            const on = !!p?.enabled;
            return (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  if (!p) return;
                  const done = on ? store.setEnabled(p.id, false) : store.setEnabled(p.id, true, p.permissions);
                  done.catch((e: unknown) => console.warn(`could not turn ${p.id} ${on ? "off" : "on"}`, e));
                }}
                className="w-full rounded-md px-2.5 py-1.5 text-left text-ink hover:bg-[#f2f2f2]"
              >
                {on ? "Turn off" : "Turn on"}
              </button>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}
