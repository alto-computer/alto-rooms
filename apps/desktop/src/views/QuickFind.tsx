import { useEffect, useMemo, useState } from "react";
import { FileText, Folder } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useRooms, useRoomsStore, useViewerStore } from "@/data/hooks";

const MAX_ROOMS = 8;
const MAX_DOCS = 30;

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * ⌘K palette over room names and artifact titles. We filter ourselves (NFC +
 * lowercase substring) rather than with cmdk's fuzzy matcher, so results are
 * deterministic. Artifacts of every room are loaded the first time it opens;
 * results fill in as rooms arrive.
 */
export function QuickFind({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useRoomsStore();
  const viewer = useViewerStore();
  const { rooms, artifacts } = useRooms();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    for (const r of rooms) void store.loadArtifacts(r.id);
  }, [open, rooms, store]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { roomHits, docHits } = useMemo(() => {
    const q = norm(query.trim());
    const roomHits = rooms.filter((r) => norm(r.name).includes(q)).slice(0, MAX_ROOMS);
    const docHits: { id: string; roomId: string; title: string; roomName: string }[] = [];
    for (const r of rooms) {
      for (const a of artifacts[r.id] ?? []) {
        if (docHits.length >= MAX_DOCS) break;
        if (norm(a.title).includes(q)) docHits.push({ id: a.id, roomId: r.id, title: a.title, roomName: r.name });
      }
    }
    return { roomHits, docHits };
  }, [query, rooms, artifacts]);

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
