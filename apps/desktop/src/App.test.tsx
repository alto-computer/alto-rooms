import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/connection";
import { attachNoteSaver, createNoteSaver, noteSaverKey, resetNoteSavers } from "@/lib/noteSaver";
import { fakeClient } from "@/test/fakes";
import App from "./App";

// Inside Tauri, with the native event bridge and the daemon connection faked.
const handlers = new Map<string, () => void>();
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, fn: () => void) => {
    handlers.set(event, fn);
    return () => handlers.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

const resolveConnection = vi.fn<() => Promise<Connection>>();
vi.mock("@/lib/connection", () => ({ resolveConnection: () => resolveConnection() }));

type Fake = ReturnType<typeof fakeClient>;
const clients: Fake[] = [];
let makeClient: () => Fake = () => fakeClient();
vi.mock("@alto-rooms/protocol-ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@alto-rooms/protocol-ts")>();
  return {
    ...real,
    createRoomsClient: vi.fn(() => {
      const f = makeClient();
      clients.push(f);
      return f.client;
    }),
  };
});

const conn = (token = "t1"): Connection => ({ baseUrl: "http://127.0.0.1:4317", token, home: "/h" });
const CORE_ERROR = "Rooms 코어를 시작하지 못했어요";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  resetNoteSavers();
  handlers.clear();
  clients.length = 0;
  makeClient = () => fakeClient();
  resolveConnection.mockReset();
  vi.useRealTimers();
});

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

/** Renders App, connected and synced against the latest fake client. */
async function connected(token = "t1") {
  resolveConnection.mockResolvedValueOnce(conn(token));
  const r = render(<App />);
  await settle();
  await act(async () => {
    clients.at(-1)!.emit({ type: "resync", roomId: null });
  });
  await settle();
  return r;
}

const nativeEvent = (event: string) =>
  act(async () => {
    const fn = handlers.get(event);
    if (!fn) throw new Error(`no listener for ${event}`);
    fn();
    await vi.advanceTimersByTimeAsync(0);
  });

describe("App: losing the daemon", () => {
  it("daemon://exited shows the core error; 다시 시도 connects again", async () => {
    await connected();
    expect(screen.getByRole("button", { name: "새 탭" })).toBeInTheDocument();
    await nativeEvent("daemon://exited");
    expect(screen.getByText(CORE_ERROR)).toBeInTheDocument();
    resolveConnection.mockResolvedValueOnce(conn());
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await settle();
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(CORE_ERROR)).toBeNull();
    expect(screen.getByRole("button", { name: "새 탭" })).toBeInTheDocument();
  });

  it("shows the core error once the store stays in error through 2 retries", async () => {
    await connected();
    clients[0].client.info = async () => {
      throw new Error("connection refused");
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      clients[0].emit({ type: "resync", roomId: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(CORE_ERROR)).toBeNull(); // 1st failure
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // 1st retry fails
    });
    expect(screen.queryByText(CORE_ERROR)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // 2nd retry fails
    });
    expect(screen.getByText(CORE_ERROR)).toBeInTheDocument();
    vi.mocked(console.warn).mockRestore();
  });

  it("a new connection (token changed) rebuilds the client and rebinds live note savers", async () => {
    await connected("t1");
    // A note that could not be saved through the old client.
    const { saver } = attachNoteSaver(
      noteSaverKey("2026-10-05", "계획.md"),
      () => createNoteSaver({ save: (text) => clients[0].client.saveNote("2026-10-05", "계획.md", text), warn: () => {} }),
      { date: "2026-10-05", name: "계획.md" },
    );
    saver.load("", null);
    clients[0].client.saveNote.mockRejectedValue(new Error("gone"));
    saver.edit("살릴 글");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await nativeEvent("daemon://exited");

    resolveConnection.mockResolvedValueOnce(conn("t2"));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await settle();
    expect(clients).toHaveLength(2);
    expect(clients[1].client.saveNote).toHaveBeenCalledWith("2026-10-05", "계획.md", "살릴 글");
    expect(clients[1].state.notes["2026-10-05/계획.md"]).toBe("살릴 글");
  });

  it("the same connection again keeps the client", async () => {
    await connected("t1");
    await nativeEvent("daemon://exited");
    resolveConnection.mockResolvedValueOnce(conn("t1"));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await settle();
    expect(clients).toHaveLength(1);
    expect(screen.queryByText(CORE_ERROR)).toBeNull();
  });
});
