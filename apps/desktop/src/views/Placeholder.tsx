import type { ReactNode } from "react";
import type { Tab } from "@/data/viewerStore";
import { monthDay } from "@/lib/dates";

/*
 * Minimal tab panels until Tasks 6–7 replace them (DocView, JournalView,
 * NoteView, NewTabView). Room tabs render RoomView.
 */

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="text-[30px] font-medium tracking-[-0.01em] text-ink">{children}</h1>;
}

export function TabPlaceholder({ tab }: { tab: Exclude<Tab, { kind: "room" }> }) {
  switch (tab.kind) {
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
