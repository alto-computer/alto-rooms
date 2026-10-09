import type { Agent } from "@alto-rooms/protocol-ts";
import { useArtifacts, useInfo, usePlugins, useRoomList } from "@/data/hooks";
import { useConversation } from "@/data/useConversation";
import type { Tab } from "@/data/viewerStore";
import { conversationTitle } from "@/lib/conversations";
import { monthDay } from "@/lib/dates";
import { noteBase } from "@/lib/notes";

/** Before the first sync we can't tell yet. */
const PENDING = "…";
const GONE_ROOM = "Missing room";
const GONE_DOC = "Missing artifact";

/** Room names come from RoomsState by id on every render; tabs never cache them. */
function RoomLabel({ roomId }: { roomId: string }) {
  const rooms = useRoomList();
  const info = useInfo();
  const name = rooms.find((r) => r.id === roomId)?.name;
  return <>{name ?? (info ? GONE_ROOM : PENDING)}</>;
}

function DocLabel({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const rooms = useRoomList();
  const info = useInfo();
  const artifacts = useArtifacts(roomId);
  const title = artifacts?.find((a) => a.id === artifactId)?.title;
  if (title !== undefined) return <>{title}</>;
  if (!info) return <>{PENDING}</>;
  // The journal room is never listed; any other room must be.
  const roomGone = roomId !== info.journalRoomId && !rooms.some((r) => r.id === roomId);
  return <>{roomGone || artifacts !== undefined ? GONE_DOC : PENDING}</>;
}

export function TabLabel({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "room":
      return <RoomLabel roomId={tab.roomId} />;
    case "doc":
      return <DocLabel roomId={tab.roomId} artifactId={tab.artifactId} />;
    case "journal":
      return <>{`Journal · ${monthDay(tab.date)}`}</>;
    case "note":
      return <>{noteBase(tab.name)}</>;
    case "plugin":
      return <PluginLabel pluginId={tab.pluginId} />;
    case "conversation":
      return <ConversationLabel agent={tab.agent} session={tab.session} />;
    case "settings":
      return <>Settings</>;
  }
}

function ConversationLabel({ agent, session }: { agent: Agent; session: string }) {
  const c = useConversation({ agent, session });
  if (c === undefined) return <>{PENDING}</>;
  if (c === null) return <>Missing session</>;
  return <>{c === "error" ? "Session" : conversationTitle(c)}</>;
}

function PluginLabel({ pluginId }: { pluginId: string }) {
  const { list, loaded } = usePlugins();
  const p = list.find((x) => x.id === pluginId);
  return <>{p?.slots.tab?.title ?? (loaded ? "Missing plugin" : PENDING)}</>;
}
