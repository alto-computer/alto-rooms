import { useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Room } from "@alto-rooms/protocol-ts";
import { FileText, Folder } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useRooms, useViewerStore, useWatchArtifacts } from "@/data/hooks";

const MAX_ROOMS = 8;
const MAX_DOCS = 30;

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * ⌘K palette over room names and artifact titles. We filter ourselves (NFC +
 * lowercase substring) rather than with cmdk's fuzzy matcher, so results are
 * deterministic. Artifacts of every room are loaded (and watched) while it is
 * open; results fill in as rooms arrive. Normalized names and titles are
 * computed once per list, not per keystroke.
 */
export function QuickFind({ open, onClose }: { open: boolean; onClose: () => void }) {
  const viewer = useViewerStore();
  const { rooms, artifacts } = useRooms();
  const [query, setQuery] = useState("");

  const roomIds = useMemo(() => (open ? rooms.map((r) => r.id) : []), [open, rooms]);
  useWatchArtifacts(roomIds);

  const roomNames = useMemo(() => rooms.map((r) => ({ room: r, key: norm(r.name) })), [rooms]);
  const titleCache = useRef(new WeakMap<readonly Artifact[], string[]>());
  const titlesOf = (list: readonly Artifact[]) => {
    let t = titleCache.current.get(list);
    if (!t) {
      t = list.map((a) => norm(a.title));
      titleCache.current.set(list, t);
    }
    return t;
  };

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { roomHits, docHits } = useMemo(() => {
    const q = norm(query.trim());
    const roomHits: Room[] = roomNames
      .filter((n) => n.key.includes(q))
      .slice(0, MAX_ROOMS)
      .map((n) => n.room);
    const docHits: { id: string; roomId: string; title: string; roomName: string }[] = [];
    for (const r of rooms) {
      const list = artifacts[r.id];
      if (!list) continue;
      const titles = titlesOf(list);
      for (let i = 0; i < list.length && docHits.length < MAX_DOCS; i++) {
        const a = list[i];
        if (titles[i].includes(q)) docHits.push({ id: a.id, roomId: r.id, title: a.title, roomName: r.name });
      }
    }
    return { roomHits, docHits };
    // titlesOf only reads its per-list cache.
  }, [query, rooms, roomNames, artifacts]);

  const done = () => onClose();

  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && onClose()} title="찾기" description="방이나 문서 찾기">
      <Command shouldFilter={false}>
        <CommandInput placeholder="방이나 문서 찾기" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>결과가 없어요</CommandEmpty>
          {roomHits.length > 0 ? (
            <CommandGroup heading="방">
              {roomHits.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`room:${r.id}`}
                  onSelect={() => {
                    viewer.open({ kind: "room", roomId: r.id });
                    done();
                  }}
                >
                  <Folder size={16} strokeWidth={1.75} aria-hidden />
                  {r.name}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {docHits.length > 0 ? (
            <CommandGroup heading="문서">
              {docHits.map((d) => (
                <CommandItem
                  key={`${d.roomId}/${d.id}`}
                  value={`doc:${d.roomId}/${d.id}`}
                  onSelect={() => {
                    viewer.open({ kind: "doc", roomId: d.roomId, artifactId: d.id });
                    done();
                  }}
                >
                  <FileText size={16} strokeWidth={1.75} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[12px] text-[#929292]">{d.roomName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
