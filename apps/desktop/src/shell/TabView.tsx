import type { Tab } from "@/data/viewerStore";
import { PluginSlot } from "@/plugins/PluginSlot";
import { DocView } from "@/views/DocView";
import { JournalView } from "@/views/JournalView";
import { NewTabView } from "@/views/NewTabView";
import { NoteView } from "@/views/NoteView";
import { RoomView } from "@/views/RoomView";

/** The active tab's view. Mounted per tab id and in-tab navigation, so mount = arriving. */
export function TabView({ tab }: { tab: Tab }) {
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
