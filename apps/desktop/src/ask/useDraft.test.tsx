import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AskScope } from "@alto-rooms/protocol-ts";
import { restoreDraft, useDraft } from "./useDraft";

const session: AskScope = { kind: "session", agent: "codex", id: "s-1" };
const OLD_KEY = "alto-rooms.askDraft.conversation:codex:s-1";
const KEY = "alto-rooms.askDraft.session:codex:s-1";

beforeEach(() => localStorage.clear());

describe("useDraft", () => {
  it("keeps an artifact's draft under its bare file key, as before scopes", () => {
    const { result } = renderHook(() => useDraft({ kind: "artifact", fileKey: "k1" }));
    act(() => result.current[1]("왜?"));
    expect(localStorage.getItem("alto-rooms.askDraft.k1")).toBe("왜?");
  });

  it("brings back a session draft saved under the conversation key, and moves it to the session key once", () => {
    localStorage.setItem(OLD_KEY, "쓰다 만 질문");
    const { result, unmount } = renderHook(() => useDraft(session));
    expect(result.current[0]).toBe("쓰다 만 질문");
    expect(localStorage.getItem(KEY)).toBe("쓰다 만 질문");
    expect(localStorage.getItem(OLD_KEY)).toBeNull();
    unmount();
    expect(renderHook(() => useDraft(session)).result.current[0]).toBe("쓰다 만 질문");
  });

  it("prefers a draft already under the session key over an old one", () => {
    localStorage.setItem(OLD_KEY, "old");
    localStorage.setItem(KEY, "new");
    expect(renderHook(() => useDraft(session)).result.current[0]).toBe("new");
    restoreDraft(session, "restored");
    expect(localStorage.getItem(KEY)).toBe("new");
  });
});
