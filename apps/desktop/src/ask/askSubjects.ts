import type { Artifact, AskScope, AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
import { modelLabel } from "./askModel";

/** What an ask bar asks about: the doc in a doc tab, the room in a room tab. */
export type AskSubject = { kind: "doc"; artifact: Artifact } | { kind: "room"; roomId: string };

export type TurnHeader = { text: string; title?: string };

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
};

const agentAndModel = (t: AskTurn) => [t.agent, t.model ? modelLabel(t.model) : null];

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
      };
    case "room":
      return {
        scope: { kind: "room", roomId: subject.roomId },
        placeholder: "Ask about this room…",
        header: (t) => ({ text: agentAndModel(t).filter(Boolean).join(" · ") }),
        agent: "Default agent",
        hint: (target) => (target?.scoped ? "Reads only this room's docs" : null),
      };
  }
}
