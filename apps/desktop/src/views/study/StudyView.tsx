import { lazy, Suspense } from "react";
import type { Tab } from "@/data/viewerStore";
import { DayPage } from "./DayPage";
import { LibraryPage } from "./LibraryPage";
import { RoomPage } from "./RoomPage";
import "./study.css";

/** React Flow and TipTap load with the first volume or book opened, not with the app. */
const VolumePage = lazy(() => import("./VolumePage").then((m) => ({ default: m.VolumePage })));
const BookPage = lazy(() => import("./BookPage").then((m) => ({ default: m.BookPage })));

/** A Study tab: the library, a room, a volume's canvas, a day, its book, or the shelf of books, by the tab's page. */
export function StudyView({ tab }: { tab: Extract<Tab, { kind: "study" }> }) {
  return <div className="study">{page(tab)}</div>;
}

function page(tab: Extract<Tab, { kind: "study" }>) {
  switch (tab.page) {
    case "library":
      return <LibraryPage />;
    case "room":
      return <RoomPage roomId={tab.roomId} />;
    case "volume":
      return (
        <Suspense fallback={null}>
          {/* Keyed: a volume's saves and its ask bar never pair one volume with another's room or number. */}
          <VolumePage key={`${tab.roomId}:${tab.number}`} roomId={tab.roomId} number={tab.number} />
        </Suspense>
      );
    case "day":
      return <DayPage key={tab.date} tabId={tab.id} date={tab.date} />;
    case "book":
      return (
        <Suspense fallback={null}>
          <BookPage key={tab.date} date={tab.date} />
        </Suspense>
      );
    case "shelf":
      return null;
  }
}
