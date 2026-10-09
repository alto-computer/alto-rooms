import { useMemo, useRef, useState } from "react";
import { useLingering } from "@/lib/useLingering";
import type { Artifact, Room } from "@alto-rooms/protocol-ts";
import { FileText, Folder } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useRooms, useViewerStore, useWatchArtifacts } from "@/data/hooks";
import { INBOX_ID } from "@/lib/drag";

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
/** How long the body outlives a close, so the dialog's fade-out still shows the results. */
const CLOSE_ANIMATION_MS = 200;

export function QuickFind({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mounted = useLingering(open, CLOSE_ANIMATION_MS);
  // A fresh body (empty query) per opening, even when reopened mid-fade.
  const [opened, setOpened] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpened((n) => n + 1);
  }
  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && onClose()} title="Find" description="Find a room or doc">
      {/* Mounted only while open (and through the close animation): a closed Find neither watches rooms nor re-renders on their changes, and opens with an empty query. */}
      {mounted ? <FindBody key={opened} onClose={onClose} /> : null}
    </CommandDialog>
  );
}

function FindBody({ onClose }: { onClose: () => void }) {
  const viewer = useViewerStore();
  const { rooms, artifacts } = useRooms();
  const [query, setQuery] = useState("");

  const roomIds = useMemo(() => rooms.map((r) => r.id), [rooms]);
  useWatchArtifacts(roomIds);

  // An empty inbox is no place to go (the sidebar hides it too).
  const roomNames = useMemo(
    () => rooms.filter((r) => r.id !== INBOX_ID || r.artifactCount > 0).map((r) => ({ room: r, key: norm(r.name) })),
    [rooms],
  );
  const titleCache = useRef(new WeakMap<readonly Artifact[], string[]>());
  const titlesOf = (list: readonly Artifact[]) => {
    let t = titleCache.current.get(list);
    if (!t) {
      t = list.map((a) => norm(a.title));
      titleCache.current.set(list, t);
    }
    return t;
  };


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
    <Command shouldFilter={false}>
      <CommandInput placeholder="Find a room or doc" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results</CommandEmpty>
        {roomHits.length > 0 ? (
          <CommandGroup heading="Rooms">
            {roomHits.map((r) => (
              <CommandItem
                key={r.id}
                value={`room:${r.id}`}
                onSelect={() => {
                  viewer.navigate({ kind: "room", roomId: r.id });
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
          <CommandGroup heading="Docs">
            {docHits.map((d) => (
              <CommandItem
                key={`${d.roomId}/${d.id}`}
                value={`doc:${d.roomId}/${d.id}`}
                onSelect={() => {
                  viewer.navigate({ kind: "doc", roomId: d.roomId, artifactId: d.id });
                  done();
                }}
              >
                <FileText size={16} strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <span className="ml-auto shrink-0 font-mono text-small text-ink-3">{d.roomName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}
