import type { Session } from "@alto-rooms/protocol-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { continueSession } from "./native";

const native = vi.hoisted(() => ({ tauri: true, invoke: vi.fn() }));
vi.mock("./tauri", () => ({ isTauri: () => native.tauri }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const session: Session = {
  agent: "claude-code",
  id: "4f2c-91",
  title: "Fix the sidebar",
  cwd: "/Users/me/it's a project",
  startedAt: "2026-10-09T01:00:00Z",
  endedAt: "2026-10-09T02:00:00Z",
  messages: 12,
  lastReply: "Done.",
  artifactsWritten: ["/Users/me/it's a project/plan.html"],
  roomId: "r1",
};

beforeEach(() => {
  native.tauri = true;
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(undefined);
});

describe("continueSession", () => {
  it("asks the shell to resume the session in the folder it started in", async () => {
    await expect(continueSession(session)).resolves.toBe(true);
    expect(native.invoke.mock.calls).toEqual([
      ["continue_session", { sessionRef: { agent: "claude-code", id: "4f2c-91" }, cwd: "/Users/me/it's a project" }],
    ]);
  });

  it("passes a missing folder as null", async () => {
    await continueSession({ ...session, agent: "aside", id: "Mall9b7x", cwd: null });
    expect(native.invoke).toHaveBeenCalledWith("continue_session", { sessionRef: { agent: "aside", id: "Mall9b7x" }, cwd: null });
  });

  it("surfaces the shell's refusal", async () => {
    native.invoke.mockRejectedValue("invalid session id");
    await expect(continueSession(session)).rejects.toBe("invalid session id");
  });

  it("does nothing in the web build", async () => {
    native.tauri = false;
    await expect(continueSession(session)).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
