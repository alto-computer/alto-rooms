import { describe, expect, it } from "vitest";
import type { Artifact, AskTarget, AskTurn, Conversation } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { frameSubject } from "./askSubjects";

const doc: Artifact = {
  id: "a1", roomId: "r1", relPath: "doc.html", title: "Doc", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: "k1",
  source: { agent: "codex", session: "S1", cwd: null, machine: null },
};
const turn = (extra: Partial<AskTurn>): AskTurn => ({
  id: "t1", scope: { kind: "doc", fileKey: "k1" }, question: "q", answer: "a", agent: "claude-code", model: "haiku", mode: "resume", status: "done",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: "2026-10-06T10:00:01+09:00", images: [], kind: "question", leftOut: 0, ...extra,
});
const target = (scoped: boolean): AskTarget => ({ agent: "claude-code", mode: "new", models: [], scoped });

describe("frameSubject", () => {
  it("frames a doc as the doc ask always has", () => {
    const f = frameSubject({ kind: "doc", artifact: doc });
    expect(scopeKey(f.scope)).toBe("doc:k1");
    expect(f.placeholder).toBe("Ask about this artifact…");
    expect(f.agent).toBe("codex");
    expect(f.header(turn({}))).toEqual({ text: "claude-code · Haiku · continuing the thread that made it" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code · New conversation", title: "Couldn't find the thread that made this artifact" });
    expect(f.hint(target(true))).toBeNull();
  });

  it("names the default agent for a doc whose agent is unknown", () => {
    expect(frameSubject({ kind: "doc", artifact: { ...doc, source: { ...doc.source, agent: null } } }).agent).toBe("Default agent");
  });

  it("frames a session by its agent and id, continuing that session", () => {
    const conversation: Conversation = { id: { agent: "codex", session: "S1" }, title: null, cwd: null, startedAt: "", endedAt: "", messages: 2, lastReply: null, artifactsWritten: [], roomId: null };
    const f = frameSubject({ kind: "conversation", conversation });
    expect(scopeKey(f.scope)).toBe("conversation:codex:S1");
    expect(f.placeholder).toBe("Ask about this session…");
    expect(f.agent).toBe("Codex");
    expect(f.header(turn({}))).toEqual({ text: "claude-code · Haiku · continuing this session" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code · New session", title: "Couldn't resume this session" });
    expect(f.hint(target(true))).toBeNull();
  });

  it("says an Aside session ask continues that session, and only for Aside", () => {
    const conversation: Conversation = { id: { agent: "aside", session: "A1" }, title: null, cwd: null, startedAt: "", endedAt: "", messages: 2, lastReply: null, artifactsWritten: [], roomId: null };
    const f = frameSubject({ kind: "conversation", conversation });
    const line = "Asks continue this Aside session; it can use the browser.";
    expect(f.note?.(null)).toBe(line);
    expect(f.note?.({ agent: "aside", mode: "resume", models: [], scoped: false })).toBe(line);
    expect(f.note?.({ agent: "aside", mode: "new", models: [], scoped: false })).toBeNull();
    const codex = frameSubject({ kind: "conversation", conversation: { ...conversation, id: { agent: "codex", session: "S1" } } });
    expect(codex.note?.(null) ?? null).toBeNull();
  });

  it("frames a room by its id, with no thread-that-made-it wording and a read hint only when scoped", () => {
    const f = frameSubject({ kind: "room", roomId: "r1" });
    expect(scopeKey(f.scope)).toBe("room:r1");
    expect(f.placeholder).toBe("Ask about this room…");
    expect(f.agent).toBe("Default agent");
    expect(f.header(turn({ mode: "new" }))).toEqual({ text: "claude-code · Haiku" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code" });
    expect(f.hint(target(true))).toBe("Reads only this room's artifacts");
    expect(f.hint(target(false))).toBeNull();
    expect(f.hint(null)).toBeNull();
  });

  it("frames a day by its date, like a room but reading only that day's items", () => {
    const f = frameSubject({ kind: "day", date: "2026-10-09" });
    expect(scopeKey(f.scope)).toBe("day:2026-10-09");
    expect(f.placeholder).toBe("Ask about this day…");
    expect(f.agent).toBe("Default agent");
    expect(f.header(turn({ mode: "new" }))).toEqual({ text: "claude-code · Haiku" });
    expect(f.hint(target(true))).toBe("Reads only this day's items");
    expect(f.hint(target(false))).toBeNull();
  });
});
