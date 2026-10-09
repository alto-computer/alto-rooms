import { useEffect, useState } from "react";
import type { Artifact, Conversation, Info, JournalDay, Note, Room, RoomColor } from "@alto-rooms/protocol-ts";
import { RoomDot } from "@/components/RoomDot";
import { useClient, useOpenDoc, useViewerStore } from "@/data/hooks";
import { conversationKey } from "@/lib/conversations";
import { clockTime } from "@/lib/dates";
import { INBOX_ID } from "@/lib/drag";
import { noteBase } from "@/lib/notes";
import { wantsNewTab } from "@/lib/nav";
import { ArtifactThumb } from "./ArtifactThumb";
import { ConversationRow } from "./ConversationRow";

/**
 * One line of a day, at the time it happened: a note of yours, an artifact an agent wrote (with
 * its room's name and pin colour), or a conversation (at its first message that day, with its room).
 */
export type DayEntry =
  | { kind: "note"; at: string; key: string; note: Note }
  | { kind: "artifact"; at: string; key: string; artifact: Artifact; label: string; color: RoomColor | null }
  | { kind: "conversation"; at: string; key: string; conversation: Conversation; room: Room | undefined };

/** The day's entries, oldest first. An artifact is labelled with its room; the Dream (the day's dream.html in the Journal) is "Review". */
export function dayEntries(day: JournalDay, info: Info, rooms: readonly Room[]): DayEntry[] {
  const label = (a: Artifact) => {
    if (a.roomId === INBOX_ID) return "Inbox";
    if (a.roomId === info.journalRoomId) return a.relPath === `${day.date}/dream.html` ? "Review" : "Journal";
    return rooms.find((r) => r.id === a.roomId)?.name ?? "Room";
  };
  const color = (a: Artifact) => rooms.find((r) => r.id === a.roomId)?.color ?? null;
  const entries: DayEntry[] = [
    ...day.notes.map((note): DayEntry => ({ kind: "note", at: note.updatedAt, key: `note:${note.name}`, note })),
    ...day.artifacts.map(
      (artifact): DayEntry => ({ kind: "artifact", at: artifact.createdAt, key: `artifact:${artifact.id}`, artifact, label: label(artifact), color: color(artifact) }),
    ),
    ...day.conversations.map(
      ({ at, conversation }): DayEntry => ({
        kind: "conversation",
        at,
        key: `conversation:${conversationKey(conversation.id)}`,
        conversation,
        room: rooms.find((r) => r.id === conversation.roomId),
      }),
    ),
  ];
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A note's text, fetched again whenever the note changes; null until it arrives or if it can't be read. */
function useNoteText(note: Note): string | null {
  const client = useClient();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.getNote(note.date, note.name).then(
      (t) => live && setText(t),
      () => live && setText(null),
    );
    return () => {
      live = false;
    };
  }, [client, note.date, note.name, note.updatedAt]);
  return text;
}

/** The first few lines of a note as they read: bullets as a list, the rest as paragraphs. */
function NoteText({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6);
  const blocks: ({ list: string[] } | { para: string })[] = [];
  for (const l of lines) {
    const item = /^[-*+]\s+(.*)$/.exec(l)?.[1];
    const last = blocks[blocks.length - 1];
    if (item === undefined) blocks.push({ para: l.replace(/^#+\s*/, "") });
    else if (last && "list" in last) last.list.push(item);
    else blocks.push({ list: [item] });
  }
  return blocks.map((b, i) =>
    "list" in b ? (
      <ul key={i} className="mt-1.5 list-disc pl-[18px] marker:text-ink-3">
        {b.list.map((t, j) => (
          <li key={j} className="my-0.5">
            {t}
          </li>
        ))}
      </ul>
    ) : (
      <p key={i} className="mt-1">
        {b.para}
      </p>
    ),
  );
}

function NoteEntry({ note }: { note: Note }) {
  const viewer = useViewerStore();
  const text = useNoteText(note);
  const name = noteBase(note.name);
  const open = (newTab: boolean) => viewer.go({ kind: "note", date: note.date, name: note.name }, newTab);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={name}
      onClick={(e) => open(wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && open(true)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        open(wantsNewTab(e));
      }}
      className="-mx-3 -my-1.5 min-w-0 cursor-pointer rounded-lg px-3 py-1.5 outline-none hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-ink"
    >
      <h3 className="font-serif text-heading leading-6 font-semibold text-ink">{name}</h3>
      {text ? (
        <div className="max-w-[60ch] font-serif text-lead leading-[1.6] text-ink-2">
          <NoteText text={text} />
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactEntry({ artifact, label, color, info }: { artifact: Artifact; label: string; color: RoomColor | null; info: Info }) {
  const openDoc = useOpenDoc();
  return (
    <button
      type="button"
      data-testid="day-artifact"
      aria-label={artifact.title}
      onClick={(e) => openDoc(artifact, wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && openDoc(artifact, true)}
      className="flex w-full max-w-[440px] min-w-0 items-center gap-3.5 rounded-xl bg-sheet p-1.5 pr-4 text-left shadow-sheet outline-none transition-[box-shadow] duration-150 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <ArtifactThumb artifact={artifact} info={info} variant="row" className="w-[104px] shrink-0 rounded-md" />
      <span className="flex min-w-0 flex-col gap-1">
        <span data-testid="card-title" className="truncate text-body font-semibold text-ink">
          {artifact.title}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-small text-ink-3">
          {color ? <RoomDot color={color} className="size-3.5" /> : null}
          <span className="truncate">{[label, artifact.source.agent].filter(Boolean).join(" · ")}</span>
        </span>
      </span>
    </button>
  );
}

type ConversationEntry = Extract<DayEntry, { kind: "conversation" }>;

/** The entries as the daybook stacks them: consecutive conversations make one run of tight rows. */
type Block = { kind: "run"; key: string; run: ConversationEntry[] } | { kind: "one"; entry: Exclude<DayEntry, ConversationEntry> };

function blocks(entries: DayEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (e.kind !== "conversation") out.push({ kind: "one", entry: e });
    else if (last?.kind === "run") last.run.push(e);
    else out.push({ kind: "run", key: e.key, run: [e] });
  }
  return out;
}

const TIME = "pr-4 text-right text-small font-medium text-ink-3 tabular-nums";

/**
 * The day as a daybook: times in the left margin against a thin rule, your notes in serif, agents'
 * artifacts as compact sheets, conversations as one line each. `selected` is the selected
 * conversation's entry key.
 */
export function Daybook({
  entries,
  info,
  selected,
  onSelect,
}: {
  entries: DayEntry[];
  info: Info;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <ol
      aria-label="Your day"
      className="relative flex flex-col gap-7 before:absolute before:top-[-4px] before:bottom-[-4px] before:left-[63px] before:w-[1.5px] before:rounded-full before:bg-thread-soft"
    >
      {blocks(entries).map((b) =>
        b.kind === "run" ? (
          <li key={b.key} className="flex flex-col">
            {b.run.map((e) => (
              <div key={e.key} className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-6">
                <time dateTime={e.at} className={`${TIME} leading-[30px]`}>
                  {clockTime(e.at)}
                </time>
                <ConversationRow conversation={e.conversation} room={e.room} entryKey={e.key} selected={selected === e.key} onSelect={() => onSelect(e.key)} />
              </div>
            ))}
          </li>
        ) : (
          <li key={b.entry.key} className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-6">
            <time dateTime={b.entry.at} className={`${TIME} leading-6`}>
              {clockTime(b.entry.at)}
            </time>
            {b.entry.kind === "note" ? (
              <NoteEntry note={b.entry.note} />
            ) : (
              <ArtifactEntry artifact={b.entry.artifact} label={b.entry.label} color={b.entry.color} info={info} />
            )}
          </li>
        ),
      )}
    </ol>
  );
}
