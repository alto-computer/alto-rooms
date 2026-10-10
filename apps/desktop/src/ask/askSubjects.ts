import type { Artifact, AskScope, AskTarget, AskTurn, Conversation } from "@alto-rooms/protocol-ts";
import { AGENT_NAMES } from "@/lib/agents";
import { modelLabel } from "./askModel";

/**
 * What an ask bar asks about: the doc in a doc tab, the session in a conversation tab, the room in a
 * room tab, the viewed day in the Journal tab.
 */
export type AskSubject =
  | { kind: "doc"; artifact: Artifact }
  | { kind: "conversation"; conversation: Conversation }
  | { kind: "room"; roomId: string }
  | { kind: "day"; date: string };

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
  /** A quiet line under the bar about where asks go; null or absent says nothing. */
  note?: (target: AskTarget | null) => string | null;
};

const agentAndModel = (t: AskTurn) => [t.agent, t.model ? modelLabel(t.model) : null];
const agentHeader = (t: AskTurn): TurnHeader => ({ text: agentAndModel(t).filter(Boolean).join(" · ") });

export function frameSubject(subject: AskSubject): SubjectFraming {
  switch (subject.kind) {
    case "doc":
      return {
        scope: { kind: "doc", fileKey: subject.artifact.fileKey },
        placeholder: "Ask about this artifact…",
        header: (t) => {
          const how = t.mode === "resume" ? "continuing the thread that made it" : "New conversation";
          const text = [...agentAndModel(t), how].filter(Boolean).join(" · ");
          return t.mode === "resume" ? { text } : { text, title: "Couldn't find the thread that made this artifact" };
        },
        agent: subject.artifact.source.agent ?? "Default agent",
        hint: () => null,
      };
    case "conversation": {
      const { id } = subject.conversation;
      return {
        scope: { kind: "conversation", agent: id.agent, session: id.session },
        placeholder: "Ask about this session…",
        header: (t) => {
          const how = t.mode === "resume" ? "continuing this session" : "New session";
          const text = [...agentAndModel(t), how].filter(Boolean).join(" · ");
          return t.mode === "resume" ? { text } : { text, title: "Couldn't resume this session" };
        },
        agent: AGENT_NAMES[id.agent],
        hint: () => null,
        // Aside asks append to the real session (roomsd resumes it); Claude Code and Codex fork it.
        note: (target) => (id.agent === "aside" && target?.mode !== "new" ? "Asks continue this Aside session; it can use the browser." : null),
      };
    }
    case "room":
      return {
        scope: { kind: "room", roomId: subject.roomId },
        placeholder: "Ask about this room…",
        header: agentHeader,
        agent: "Default agent",
        hint: (target) => (target?.scoped ? "Reads only this room's artifacts" : null),
      };
    case "day":
      return {
        scope: { kind: "day", date: subject.date },
        placeholder: "Ask about this day…",
        header: agentHeader,
        agent: "Default agent",
        hint: (target) => (target?.scoped ? "Reads only this day's items" : null),
      };
  }
}
