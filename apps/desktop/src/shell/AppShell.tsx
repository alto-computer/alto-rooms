import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useViewer, useViewerStore } from "@/data/hooks";
import type { Tab, ViewerStore } from "@/data/viewerStore";
import { cn } from "@/lib/utils";
import { DocView } from "@/views/DocView";
import { JournalView } from "@/views/JournalView";
import { NoteView } from "@/views/NoteView";
import { NewTabView } from "@/views/NewTabView";
import { QuickFind } from "@/views/QuickFind";
import { RoomView } from "@/views/RoomView";
import { Sidebar } from "./Sidebar";
import { TAB_PANEL_ID, TabBar, tabDomId } from "./TabBar";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The letter of a shortcut: `key` when it's latin, else the physical key (Korean IME gives "ㅠ" for B). */
function shortcutLetter(e: KeyboardEvent): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
}

/** ⌘B sidebar, ⌘W close tab, ⌘T new tab, ⌘K quick find. Bound on window. */
function useShortcuts(viewer: ViewerStore, openFind: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || (!IS_MAC && e.ctrlKey);
      if (!mod || e.shiftKey || e.altKey || e.isComposing) return;
      const s = viewer.getState();
      switch (shortcutLetter(e)) {
        case "b":
          e.preventDefault();
          viewer.setSidebarOpen(!s.sidebarOpen);
          break;
        case "w":
          e.preventDefault();
          if (s.activeId) viewer.close(s.activeId);
          break;
        case "t":
          e.preventDefault();
          viewer.open({ kind: "new" });
          break;
        case "k":
          e.preventDefault();
          openFind();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, openFind]);
}

/** The active tab's view. Mounted per tab id, so mount = activation. */
function TabView({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "room":
      return <RoomView roomId={tab.roomId} />;
    case "doc":
      return <DocView roomId={tab.roomId} artifactId={tab.artifactId} />;
    case "journal":
      return <JournalView tabId={tab.id} date={tab.date} />;
    case "note":
      return <NoteView date={tab.date} name={tab.name} />;
    case "new":
      return <NewTabView />;
  }
}

const SIDEBAR_STYLE = { "--sidebar-width": "232px" } as CSSProperties;

export function AppShell() {
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();
  const [findOpen, setFindOpen] = useState(false);
  const openFind = useCallback(() => setFindOpen(true), []);
  useShortcuts(viewer, openFind);

  const active = tabs.find((t) => t.id === activeId);

  return (
    <TooltipProvider>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={(open) => viewer.setSidebarOpen(open)}
        style={SIDEBAR_STYLE}
        className="h-svh min-h-0 overflow-hidden bg-surface text-ink"
      >
        <Sidebar onFind={openFind} />
        {/* Content column: padding 8px 8px 8px 0 (8px on the left too once the sidebar is gone). */}
        <div className={cn("flex min-w-0 flex-1 flex-col py-2 pr-2", sidebarOpen ? "pl-0" : "pl-2")}>
          <TabBar />
          <main
            id={TAB_PANEL_ID}
            role="tabpanel"
            aria-labelledby={active ? tabDomId(active.id) : undefined}
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-[#ddd] bg-white"
          >
            {active ? <TabView key={active.id} tab={active} /> : null}
          </main>
        </div>
        <QuickFind open={findOpen} onClose={() => setFindOpen(false)} />
      </SidebarProvider>
    </TooltipProvider>
  );
}
