import { describe, expect, it } from "vitest";
import type { Artifact, AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
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
    expect(f.placeholder).toBe("Ask about this doc…");
    expect(f.agent).toBe("codex");
    expect(f.header(turn({}))).toEqual({ text: "claude-code · Haiku · continuing the thread that made it" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code · New conversation", title: "Couldn't find the thread that made this doc" });
    expect(f.hint(target(true))).toBeNull();
  });

  it("names the default agent for a doc whose agent is unknown", () => {
    expect(frameSubject({ kind: "doc", artifact: { ...doc, source: { ...doc.source, agent: null } } }).agent).toBe("Default agent");
  });

  it("frames a room by its id, with no thread-that-made-it wording and a read hint only when scoped", () => {
    const f = frameSubject({ kind: "room", roomId: "r1" });
    expect(scopeKey(f.scope)).toBe("room:r1");
    expect(f.placeholder).toBe("Ask about this room…");
    expect(f.agent).toBe("Default agent");
    expect(f.header(turn({ mode: "new" }))).toEqual({ text: "claude-code · Haiku" });
    expect(f.header(turn({ mode: "new", model: null }))).toEqual({ text: "claude-code" });
    expect(f.hint(target(true))).toBe("Reads only this room's docs");
    expect(f.hint(target(false))).toBeNull();
    expect(f.hint(null)).toBeNull();
  });
});
