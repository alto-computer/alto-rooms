import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAsksStore, useReadOnly, useViewer, useViewerStore } from "@/data/hooks";
import type { Tab, ViewerStore } from "@/data/viewerStore";
import { listenAll, MENU_BACK, MENU_CLOSE_TAB, MENU_FIND, MENU_FORWARD, MENU_NEW_TAB, MENU_TOGGLE_ASK, MENU_TOGGLE_SIDEBAR } from "@/lib/appEvents";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { DocView } from "@/views/DocView";
import { JournalView } from "@/views/JournalView";
import { NoteView } from "@/views/NoteView";
import { NewTabView } from "@/views/NewTabView";
import { QuickFind } from "@/views/QuickFind";
import { RoomView } from "@/views/RoomView";
import { EnableCard } from "@/plugins/EnableCard";
import { PluginSlot } from "@/plugins/PluginSlot";
import { allowedWithFocus, historyKey, isMenuHistoryKey, isTextField, keyAction, type ShortcutAction } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { TAB_PANEL_ID, TabBar, tabDomId } from "./TabBar";

/** Runs a shell action (callers check the focus rule first). */
function runAction(action: ShortcutAction, viewer: ViewerStore, openFind: () => void, toggleAsk: () => void) {
  const s = viewer.getState();
  switch (action) {
    case "toggle-sidebar":
      viewer.setSidebarOpen(!s.sidebarOpen);
      break;
    case "close-tab":
      if (s.activeId) viewer.close(s.activeId);
      break;
    case "new-tab":
      viewer.open({ kind: "new" });
      break;
    case "find":
      openFind();
      break;
    case "toggle-ask":
      toggleAsk();
      break;
  }
}

/**
 * ⌘B sidebar, ⌘W close tab, ⌘T new tab, ⌘K quick find, ⌘J ask bar. Bound on window.
 * In Tauri all five belong to the native menu (which emits `menu://…`), so the
 * page leaves them alone and they never fire twice. Either way the same focus
 * rule applies: ⌘K and ⌘J work from a text field, the others don't (except ⌘W from
 * the note body).
 */
function useShortcuts(viewer: ViewerStore, openFind: () => void, toggleAsk: () => void) {
  useEffect(() => {
    const menuOwned = isTauri();
    const onKey = (e: KeyboardEvent) => {
      const action = keyAction(e);
      if (!action) return;
      if (menuOwned) return;
      if (!allowedWithFocus(action, e.target instanceof Element ? e.target : null)) return;
      e.preventDefault();
      runAction(action, viewer, openFind, toggleAsk);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, openFind, toggleAsk]);

  useEffect(() => {
    if (!isTauri()) return;
    const fromMenu = (action: ShortcutAction) => () => {
      if (allowedWithFocus(action, document.activeElement)) runAction(action, viewer, openFind, toggleAsk);
    };
    return listenAll({
      [MENU_NEW_TAB]: fromMenu("new-tab"),
      [MENU_CLOSE_TAB]: fromMenu("close-tab"),
      [MENU_FIND]: fromMenu("find"),
      [MENU_TOGGLE_SIDEBAR]: fromMenu("toggle-sidebar"),
      [MENU_TOGGLE_ASK]: fromMenu("toggle-ask"),
    });
  }, [viewer, openFind, toggleAsk]);
}

/**
 * Back/forward in the active tab: ⌘[ / ⌘] and ⌘← / ⌘→ (not from a text field, where
 * they indent or move the caret) and the mouse's back/forward buttons (3/4). In
 * Tauri the native menu (View › Back/Forward) owns ⌘[ / ⌘], as with the other shortcuts.
 */
function useHistoryNav(viewer: ViewerStore) {
  useEffect(() => {
    const menuOwned = isTauri();
    const go = (dir: "back" | "forward") => (dir === "back" ? viewer.back() : viewer.forward());
    const unlisten = menuOwned
      ? listenAll({
          [MENU_BACK]: () => !isTextField(document.activeElement) && go("back"),
          [MENU_FORWARD]: () => !isTextField(document.activeElement) && go("forward"),
        })
      : null;
    const onKey = (e: KeyboardEvent) => {
      if (menuOwned && isMenuHistoryKey(e)) return;
      const dir = historyKey(e);
      if (!dir || isTextField(e.target instanceof Element ? e.target : null)) return;
      e.preventDefault();
      go(dir);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) viewer.back();
      else viewer.forward();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [viewer]);
}

/** The active tab's view. Mounted per tab id and in-tab navigation, so mount = arriving. */
function TabView({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "room":
      return <RoomView roomId={tab.roomId} />;
    case "doc":
      return <DocView roomId={tab.roomId} artifactId={tab.artifactId} />;
    case "journal":
      return <JournalView tabId={tab.id} date={tab.date} />;
    case "note":
      return <NoteView tabId={tab.id} date={tab.date} name={tab.name} />;
    case "new":
      return <NewTabView />;
    case "plugin":
      return <PluginSlot slot="tab" pluginId={tab.pluginId} context={{}} />;
  }
}

const SIDEBAR_STYLE = { "--sidebar-width": "232px" } as CSSProperties;

export function AppShell() {
  const { tabs, activeId, sidebarOpen } = useViewer();
  const viewer = useViewerStore();
  const [findOpen, setFindOpen] = useState(false);
  const openFind = useCallback(() => setFindOpen(true), []);
  const asks = useAsksStore();
  const readOnly = useReadOnly();
  const activeKind = tabs.find((t) => t.id === activeId)?.kind;
  const toggleAsk = useCallback(() => {
    if (activeKind === "doc" && !readOnly) asks.toggle();
  }, [activeKind, readOnly, asks]);
  useShortcuts(viewer, openFind, toggleAsk);
  useHistoryNav(viewer);

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
            {active ? <TabView key={viewer.navKey(active.id)} tab={active} /> : null}
          </main>
        </div>
        <QuickFind open={findOpen} onClose={() => setFindOpen(false)} />
        <EnableCard />
      </SidebarProvider>
    </TooltipProvider>
  );
}
