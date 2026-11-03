import { useEffect, useMemo, useState } from "react";
import type { StudyDayBook } from "@alto-rooms/protocol-ts";
import { AskBar } from "@/ask/AskBar";
import { useFrameAfter } from "@/ask/useFrameAfter";
import { useClient, useReadOnly } from "@/data/hooks";
import { CanvasTools, CardCanvas, type CanvasFollow } from "./CardCanvas";
import { shortDate } from "./study";
import { useStudyGo } from "./StudyNav";

/** 하루 책: the canvas a day is wrapped up on. Any day's book can be written, and it saves itself. */
export function BookPage({ date }: { date: string }) {
  const client = useClient();
  const [book, setBook] = useState<StudyDayBook | "missing" | null>(null);
  useEffect(() => {
    let live = true;
    client.studyDayBook(date).then(
      (b) => live && setBook(b),
      (e: unknown) => {
        console.warn("rooms: could not load the day book", e);
        if (live) setBook("missing");
      },
    );
    return () => {
      live = false;
    };
  }, [client, date]);

  if (book === null) return null;
  if (book === "missing") return <p className="st-lede st-sub p-16">Book not found</p>;
  return <Book date={date} book={book} />;
}

function Book({ date, book }: { date: string; book: StudyDayBook }) {
  const client = useClient();
  const go = useStudyGo();
  const readOnly = useReadOnly();
  const barReady = useFrameAfter(true);
  const bar = useMemo(() => <AskBar subject={{ kind: "studyDayBook", date }} />, [date]);
  const follow: CanvasFollow | null = readOnly
    ? null
    : {
        about: (type, e) => type === "resync" || (e.type === "study.changed" && e.roomId === null),
        load: () => client.studyDayBook(date),
      };

  return (
    <CardCanvas
      content={book}
      readOnly={readOnly}
      save={(body) => client.saveStudyDayBook(date, body)}
      follow={follow}
      lead={
        <button type="button" className="st-backlink" onClick={(e) => go({ page: "day", date }, e)}>
          ← {shortDate(date)}
        </button>
      }
      titleLabel="Title"
      acts={(controls) =>
        readOnly ? null : <CanvasTools add={controls.add} />
      }
      bar={barReady && !readOnly ? bar : null}
    />
  );
}
