import { useEffect, useState } from "react";
import type { StudyDayBookSummary } from "@alto-rooms/protocol-ts";
import { useClient, useRoomsStore } from "@/data/hooks";

/**
 * The day books with a title or a card, newest first; null until the first load. Loaded again when
 * roomsd says a day or a book changed, or the event stream resyncs.
 */
export function useDayBooks(): StudyDayBookSummary[] | null {
  const client = useClient();
  const rooms = useRoomsStore();
  const [books, setBooks] = useState<StudyDayBookSummary[] | null>(null);
  useEffect(() => {
    let gen = 0;
    const load = () => {
      const asked = ++gen;
      client.studyDayBooks().then(
        (r) => asked === gen && setBooks(r.books),
        (e: unknown) => console.warn("rooms: could not load the day books", e),
      );
    };
    load();
    const stop = rooms.onSignal((type, e) => {
      if (type === "resync" || (e.type === "study.changed" && e.roomId === null)) load();
    });
    return () => {
      gen = -1;
      stop();
    };
  }, [client, rooms]);
  return books;
}
