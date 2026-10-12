import type { Tab } from "@/data/viewerStore";
import { PluginSlot } from "@/plugins/PluginSlot";
import { ArtifactView } from "@/views/ArtifactView";
import { JournalView } from "@/views/JournalView";
import { NoteView } from "@/views/NoteView";
import { RoomView } from "@/views/RoomView";
import { SessionView } from "@/views/SessionView";
import { SettingsView } from "@/views/SettingsView";

/** The active tab's view. Mounted per tab id and in-tab navigation, so mount = arriving. */
export function TabView({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "room":
      return <RoomView roomId={tab.roomId} />;
    case "artifact":
      return <ArtifactView roomId={tab.roomId} artifactId={tab.artifactId} />;
    case "journal":
      return <JournalView tabId={tab.id} date={tab.date} />;
    case "note":
      return <NoteView tabId={tab.id} date={tab.date} name={tab.name} />;
    case "plugin":
      return <PluginSlot slot="tab" pluginId={tab.pluginId} context={{}} />;
    case "session":
      return <SessionView sessionRef={{ agent: tab.agent, id: tab.sessionId }} />;
    case "settings":
      return <SettingsView />;
  }
}
