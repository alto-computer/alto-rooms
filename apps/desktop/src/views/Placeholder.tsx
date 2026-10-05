import type { ReactNode } from "react";
import { useClient, useRooms } from "@/data/hooks";
import type { Tab } from "@/data/viewerStore";
import { monthDay } from "@/lib/dates";
import { EditableTitle } from "./EditableTitle";

/*
 * Minimal tab panels until Tasks 5–7 replace them (RoomView, DocView,
 * JournalView, NoteView, NewTabView). The room panel's editable title is
 * Task 4's (AC-6) and stays.
 */

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

export function RoomPlaceholder({ roomId }: { roomId: string }) {
  const { rooms, info } = useRooms();
  const client = useClient();
  const room = rooms.find((r) => r.id === roomId);
  if (!room) {
    // Before the first sync we can't tell; afterwards the room is gone.
    return info ? <Centered>이 방은 더 이상 없어요</Centered> : <div className="flex-1 bg-surface" />;
  }
  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-surface px-12 pt-10 pb-6">
      <header className="flex flex-col gap-1">
        <EditableTitle
          key={room.id}
          value={room.name}
          readOnly={info?.readOnly}
          ariaLabel="방 이름"
          hint="Enter 또는 바깥을 누르면 저장"
          onSave={async (next) => {
            await client.renameRoom(room.id, next);
          }}
          className="text-[30px] leading-[1.25] font-medium tracking-[-0.01em] text-ink"
          inputClassName="-ml-2 w-full max-w-[560px] rounded-lg px-2 py-0.5 outline-2 outline-solid outline-[#222]"
        />
        <p className="text-[16px] text-ink-2">문서 {room.artifactCount}</p>
      </header>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="text-[30px] font-medium tracking-[-0.01em] text-ink">{children}</h1>;
}

export function TabPlaceholder({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "room":
      return <RoomPlaceholder roomId={tab.roomId} />;
    case "doc":
      return <div className="flex-1 bg-white" />;
    case "journal":
      return (
        <div className="flex flex-1 flex-col bg-white px-12 pt-9 pb-6">
          <Heading>{monthDay(tab.date)}</Heading>
        </div>
      );
    case "note":
      return (
        <div className="flex flex-1 flex-col bg-white px-12 py-10">
          <Heading>{tab.name.replace(/\.md$/, "")}</Heading>
        </div>
      );
    case "new":
      return (
        <div className="flex flex-1 flex-col bg-white px-12 pt-14 pb-10">
          <h1 className="text-[32px] font-medium text-ink">지난 방문 이후</h1>
        </div>
      );
  }
}
