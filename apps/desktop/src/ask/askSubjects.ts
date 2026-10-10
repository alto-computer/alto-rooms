import type { Artifact, AskScope, AskTarget, AskTurn, Room } from "@alto-rooms/protocol-ts";
import { localDate } from "@/lib/dates";
import { modelLabel } from "./askModel";

/** What an ask bar asks about: the doc in a doc tab, the room in a room tab, the viewed day in the Journal tab. */
export type AskSubject = { kind: "doc"; artifact: Artifact } | { kind: "room"; roomId: string } | { kind: "day"; date: string };

export type TurnHeader = { text: string; title?: string };

/** Where "Save as note" files an answer: a Journal day, and the line on top naming where the answer came from. */
export type NoteTarget = { date: string; source: string | null };

/** Resolved when the user saves, so it names the room as it is called then and the day it is then. */
export type NoteTargetOf = (now: Date, rooms: readonly Room[]) => NoteTarget;

/** How a bar presents its subject: what the shared Composer and ThreadSheet show for it. */
export type SubjectFraming = {
  scope: AskScope;
  placeholder: string;
  /** The line above a thread: who answered its last turn, and how. */
  header: (t: AskTurn) => TurnHeader;
  /** The agent chip until roomsd names the target. */
  agent: string;
  /** Said beside the agent chip about what the agent may read; null says nothing. */
  hint: (target: AskTarget | null) => string | null;
  /** Where an answer is saved as a note; null when this subject's answers can't be saved. */
  noteTarget: NoteTargetOf | null;
};

const agentAndModel = (t: AskTurn) => [t.agent, t.model ? modelLabel(t.model) : null];
const agentHeader = (t: AskTurn): TurnHeader => ({ text: agentAndModel(t).filter(Boolean).join(" · ") });

export function frameSubject(subject: AskSubject): SubjectFraming {
  switch (subject.kind) {
    case "doc":
      return {
        scope: { kind: "doc", fileKey: subject.artifact.fileKey },
        placeholder: "Ask about this doc…",
        header: (t) => {
          const how = t.mode === "resume" ? "continuing the thread that made it" : "New conversation";
          const text = [...agentAndModel(t), how].filter(Boolean).join(" · ");
          return t.mode === "resume" ? { text } : { text, title: "Couldn't find the thread that made this doc" };
        },
        agent: subject.artifact.source.agent ?? "Default agent",
        hint: () => null,
        noteTarget: null,
      };
    case "room":
      return {
        scope: { kind: "room", roomId: subject.roomId },
        placeholder: "Ask about this room…",
        header: agentHeader,
        agent: "Default agent",
        hint: (target) => (target?.scoped ? "Reads only this room's docs" : null),
        noteTarget: (now, rooms) => ({
          date: localDate(now),
          source: `Room: ${rooms.find((r) => r.id === subject.roomId)?.name ?? subject.roomId}`,
        }),
      };
    case "day":
      return {
        scope: { kind: "day", date: subject.date },
        placeholder: "Ask about this day…",
        header: agentHeader,
        agent: "Default agent",
        hint: (target) => (target?.scoped ? "Reads only this day's items" : null),
        noteTarget: () => ({ date: subject.date, source: null }),
      };
  }
}
