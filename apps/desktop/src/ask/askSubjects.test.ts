import { describe, expect, it } from "vitest";
import type { Artifact, AskTurn, Conversation, Room } from "@alto-rooms/protocol-ts";
import { scopeKey } from "@alto-rooms/protocol-ts";
import { frameSubject } from "./askSubjects";

const doc: Artifact = {
  id: "a1", roomId: "r1", relPath: "doc.html", title: "Doc", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: "k1",
  source: { agent: "codex", session: "S1", cwd: null, machine: null },
};
const turn = (extra: Partial<AskTurn>): AskTurn => ({
  id: "t1", scope: { kind: "doc", fileKey: "k1" }, question: "q", answer: "a", agent: "claude-code", model: "haiku", mode: "resume", status: "done",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: "2026-10-06T10:00:01+09:00", images: [], kind: "question", leftOut: 0, session: null, ...extra,
});
const room: Room = { id: "r1", name: "Planning", kind: "owned", path: "/p", status: "ok", artifactCount: 1, updatedAt: null, color: null };
const late = new Date(2026, 9, 9, 23, 30);

describe("frameSubject", () => {
  it("frames a doc as the doc ask always has", () => {
    const f = frameSubject({ kind: "doc", artifact: doc });
    expect(scopeKey(f.scope)).toBe("doc:k1");
    expect(f.placeholder).toBe("Ask about this artifact…");
    expect(f.agent).toBe("codex");
    expect(f.header(turn({}))).toEqual({ text: "claude-code · Haiku · continuing the thread that made it" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code · New conversation", title: "Couldn't find the thread that made this artifact" });
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

  it("frames a room by its id, with no thread-that-made-it wording", () => {
    const f = frameSubject({ kind: "room", roomId: "r1" });
    expect(scopeKey(f.scope)).toBe("room:r1");
    expect(f.placeholder).toBe("Ask about this room…");
    expect(f.agent).toBe("Default agent");
    expect(f.header(turn({ mode: "new" }))).toEqual({ text: "claude-code · Haiku" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code" });
  });

  it("frames a day by its date, like a room but reading only that day's items", () => {
    const f = frameSubject({ kind: "day", date: "2026-10-09" });
    expect(scopeKey(f.scope)).toBe("day:2026-10-09");
    expect(f.placeholder).toBe("Ask about this day…");
    expect(f.agent).toBe("Default agent");
    expect(f.header(turn({ mode: "new" }))).toEqual({ text: "claude-code · Haiku" });
  });

  describe("noteTarget", () => {
    it("saves no doc answer", () => {
      expect(frameSubject({ kind: "doc", artifact: doc }).noteTarget).toBeNull();
    });

    it("saves a room answer into today's Journal, named by the room as it is called at save time", () => {
      const save = frameSubject({ kind: "room", roomId: "r1" }).noteTarget!;
      expect(save(late, [room])).toEqual({ date: "2026-10-09", source: "Room: Planning" });
      expect(save(new Date(2026, 9, 10, 0, 5), [{ ...room, name: "Renamed" }])).toEqual({ date: "2026-10-10", source: "Room: Renamed" });
    });

    it("saves a session answer into today's Journal, named by the session's title", () => {
      const conversation: Conversation = { id: { agent: "codex", session: "S1" }, title: "Fix the sync bug", cwd: null, startedAt: "", endedAt: "", messages: 2, lastReply: null, artifactsWritten: [], roomId: null };
      expect(frameSubject({ kind: "conversation", conversation }).noteTarget!(late, [room])).toEqual({ date: "2026-10-09", source: "Session: Fix the sync bug" });
      const untitled = frameSubject({ kind: "conversation", conversation: { ...conversation, title: null } }).noteTarget!(late, [room]);
      expect(untitled.source).toBe("Session: Untitled session");
    });

    it("saves a day answer into the viewed day, whatever today is, with no source line", () => {
      expect(frameSubject({ kind: "day", date: "2026-10-01" }).noteTarget!(late, [room])).toEqual({ date: "2026-10-01", source: null });
    });
  });
});
