import { Activity, lazy, Suspense, useCallback, useState, type CSSProperties } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAsksStore, useReadOnly, useViewer, useViewerStore } from "@/data/hooks";
import type { Tab } from "@/data/viewerStore";
import { cn } from "@/lib/utils";
import { EnableCard } from "@/plugins/EnableCard";
import { CurrentTabContext, TabVisibleContext } from "./currentTab";
import { Sidebar } from "./Sidebar";
import { TAB_PANEL_ID, tabDomId } from "./tabIds";
import { TabBar } from "./TabBar";
import { TabView } from "./TabView";
import { useMountedTabs } from "./useMountedTabs";
import { useShellKeys } from "./useShellKeys";

/** cmdk + dialog load on the first ⌘K, then stay mounted. */
const QuickFind = lazy(() => import("@/views/QuickFind").then((m) => ({ default: m.QuickFind })));

const SIDEBAR_STYLE = { "--sidebar-width": "232px" } as CSSProperties;

/** Tab kinds with an ask bar for ⌘J to toggle. */
const ASKABLE = new Set<Tab["kind"]>(["doc", "room", "journal"]);

export function AppShell() {
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();
  const [findOpen, setFindOpen] = useState(false);
  const [findLoaded, setFindLoaded] = useState(false);
  const openFind = useCallback(() => {
    setFindLoaded(true);
    setFindOpen(true);
  }, []);
  const asks = useAsksStore();
  const readOnly = useReadOnly();
  const active = tabs.find((t) => t.id === activeId);
  const activeKind = active?.kind;
  const toggleAsk = useCallback(() => {
    if (activeKind && ASKABLE.has(activeKind) && !readOnly) asks.toggle();
  }, [activeKind, readOnly, asks]);
  useShellKeys(viewer, openFind, toggleAsk);
  const mounted = useMountedTabs(tabs, active);

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
            {mounted.map((tab) => (
              <Activity key={viewer.navKey(tab.id)} mode={tab === active ? "visible" : "hidden"}>
                <CurrentTabContext.Provider value={tab.id}>
                  <TabVisibleContext.Provider value={tab === active}>
                    <TabView tab={tab} />
                  </TabVisibleContext.Provider>
                </CurrentTabContext.Provider>
              </Activity>
            ))}
          </main>
        </div>
        {findLoaded ? (
          <Suspense fallback={null}>
            <QuickFind open={findOpen} onClose={() => setFindOpen(false)} />
          </Suspense>
        ) : null}
        <EnableCard />
        <Toaster />
      </SidebarProvider>
    </TooltipProvider>
  );
}
