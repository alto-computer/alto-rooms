import type { Artifact, AskScope, AskTarget, AskTurn, Room, Session } from "@alto-rooms/protocol-ts";
import { AGENT_NAMES } from "@/lib/agents";
import { sessionTitle } from "@/lib/sessions";
import { localDate } from "@/lib/dates";
import { modelLabel } from "./askModel";

/**
 * What an ask bar asks about: the artifact in an artifact tab, the session in a session tab, the
 * room in a room tab, the viewed day in the Journal tab.
 */
export type AskSubject =
  | { kind: "artifact"; artifact: Artifact }
  | { kind: "session"; session: Session }
  | { kind: "room"; roomId: string }
  | { kind: "day"; date: string };

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
  /** A quiet line under the bar about where asks go; null or absent says nothing. */
  note?: (target: AskTarget | null) => string | null;
  /** Where an answer is saved as a note; null when this subject's answers can't be saved. */
  noteTarget: NoteTargetOf | null;
};

const agentAndModel = (t: AskTurn) => [t.agent, t.model ? modelLabel(t.model) : null];
const agentHeader = (t: AskTurn): TurnHeader => ({ text: agentAndModel(t).filter(Boolean).join(" · ") });

export function frameSubject(subject: AskSubject): SubjectFraming {
  switch (subject.kind) {
    case "artifact":
      return {
        scope: { kind: "artifact", fileKey: subject.artifact.fileKey },
        placeholder: "Ask about this artifact…",
        header: (t) => {
          const how = { resume: "continuing the thread that made it", continue: "continuing this conversation", new: "New conversation" }[t.mode];
          const text = [...agentAndModel(t), how].filter(Boolean).join(" · ");
          return t.mode === "new" ? { text, title: "Couldn't find the thread that made this artifact" } : { text };
        },
        agent: subject.artifact.source.agent ?? "Default agent",
        noteTarget: null,
      };
    case "session": {
      const { agent, id } = subject.session;
      return {
        scope: { kind: "session", agent, id },
        placeholder: "Ask about this session…",
        header: (t) => {
          const how = { resume: "continuing this session", continue: "continuing this conversation", new: "New session" }[t.mode];
          const text = [...agentAndModel(t), how].filter(Boolean).join(" · ");
          return t.mode === "new" ? { text, title: "Couldn't resume this session" } : { text };
        },
        agent: AGENT_NAMES[agent],
        // Aside asks append to the real session (roomsd resumes it); Claude Code and Codex fork it.
        note: (target) => (agent === "aside" && target?.mode !== "new" ? "Asks continue this Aside session; it can use the browser." : null),
        noteTarget: (now) => ({ date: localDate(now), source: `Session: ${sessionTitle(subject.session)}` }),
      };
    }
    case "room":
      return {
        scope: { kind: "room", roomId: subject.roomId },
        placeholder: "Ask about this room…",
        header: agentHeader,
        agent: "Default agent",
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
        noteTarget: () => ({ date: subject.date, source: null }),
      };
  }
}
