import type { Artifact, RoomsEvent } from "@alto-rooms/protocol-ts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StoresProvider, useArtifacts, useRooms, useScopeError, useViewer } from "./hooks";
import { RoomsStore, type RoomsClientLike } from "./roomsStore";
import { ViewerStore } from "./viewerStore";

afterEach(cleanup);

const a1: Artifact = {
  id: "a1",
  roomId: "r1",
  relPath: "a1.html",
  title: "First",
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
};

function client() {
  let emit: (e: RoomsEvent) => void = () => {};
  const calls = { listArtifacts: 0 };
  let failArtifacts = false;
  let roomList = [{ id: "r1", name: "Room one", kind: "owned" as const, path: "/h/r1", status: "ok" as const, artifactCount: 1, updatedAt: null }];
  const c: RoomsClientLike = {
    info: async () => ({ version: "0", readOnly: false, home: "/h", journalRoomId: "j", filesOrigin: "http://f" }),
    listRooms: async () => ({ data: roomList, seq: 1 }),
    listArtifacts: async () => {
      calls.listArtifacts++;
      if (failArtifacts) throw new Error("boom");
      return { data: [a1], seq: 1 };
    },
    journalDay: async (date) => ({ data: { date, artifacts: [], notes: [] }, seq: 1 }),
    subscribe: (onEvent) => {
      emit = onEvent;
      return () => {};
    },
  };
  return {
    c,
    calls,
    emit: (e: RoomsEvent) => emit(e),
    failArtifacts: (v: boolean) => {
      failArtifacts = v;
    },
    setRooms: (r: typeof roomList) => {
      roomList = r;
    },
  };
}

function Probe() {
  const { status, rooms } = useRooms();
  const arts = useArtifacts("r1");
  const viewer = useViewer();
  const error = useScopeError("room:r1");
  return (
    <p>
      {status}|{rooms.map((r) => r.name).join(",")}|{arts?.map((a) => a.title).join(",") ?? "loading"}|{viewer.tabs.length}
      {error ? `|error:${error}` : ""}
    </p>
  );
}

describe("hooks", () => {
  it("render store state and update on events", async () => {
    const { c, emit } = client();
    const rooms = new RoomsStore(c);
    const viewer = new ViewerStore({ getItem: () => null, setItem: () => {} });
    render(
      <StoresProvider rooms={rooms} viewer={viewer}>
        <Probe />
      </StoresProvider>,
    );
    await act(async () => {
      rooms.start();
      emit({ seq: 1, type: "resync", roomId: null });
    });
    expect(await screen.findByText("live|Room one|First|1")).toBeTruthy();
    act(() => emit({ seq: 2, type: "artifact.added", artifact: { ...a1, id: "a2", title: "Second", createdAt: "2026-10-05T01:00:00Z" } }));
    expect(screen.getByText("live|Room one|First,Second|1")).toBeTruthy();
    rooms.stop();
  });

  it("useArtifacts loads again when a removed room is re-added or pruned and comes back", async () => {
    const h = client();
    const rooms = new RoomsStore(h.c);
    const viewer = new ViewerStore({ getItem: () => null, setItem: () => {} });
    render(
      <StoresProvider rooms={rooms} viewer={viewer}>
        <Probe />
      </StoresProvider>,
    );
    await act(async () => {
      rooms.start();
      h.emit({ seq: 1, type: "resync", roomId: null });
    });
    expect(await screen.findByText("live|Room one|First|1")).toBeTruthy();

    await act(async () => h.emit({ seq: 2, type: "room.removed", roomId: "r1" }));
    expect(screen.getByText("live||loading|1")).toBeTruthy();
    await act(async () =>
      h.emit({ seq: 3, type: "room.added", room: { id: "r1", name: "Back", kind: "owned", path: "/h/r1", status: "ok", artifactCount: 1, updatedAt: null } }),
    );
    expect(await screen.findByText("live|Back|First|1")).toBeTruthy();

    // Pruned by a resync, then reappears on the next one.
    const keep = [{ id: "r1", name: "Again", kind: "owned" as const, path: "/h/r1", status: "ok" as const, artifactCount: 1, updatedAt: null }];
    h.setRooms([]);
    await act(async () => h.emit({ seq: 4, type: "resync", roomId: null }));
    expect(screen.getByText("live||loading|1")).toBeTruthy();
    h.setRooms(keep);
    await act(async () => h.emit({ seq: 5, type: "resync", roomId: null }));
    expect(await screen.findByText("live|Again|First|1")).toBeTruthy();
    rooms.stop();
  });

  it("useScopeError exposes a failed first load", async () => {
    const h = client();
    h.failArtifacts(true);
    const rooms = new RoomsStore(h.c, { warn: () => {} });
    const viewer = new ViewerStore({ getItem: () => null, setItem: () => {} });
    render(
      <StoresProvider rooms={rooms} viewer={viewer}>
        <Probe />
      </StoresProvider>,
    );
    await act(async () => {
      rooms.start();
      h.emit({ seq: 1, type: "resync", roomId: null });
    });
    expect(await screen.findByText("live|Room one|loading|1|error:boom")).toBeTruthy();
    rooms.stop();
  });

  it("throws without a provider", () => {
    const orig = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Probe />)).toThrow("StoresProvider is missing");
    } finally {
      console.error = orig;
    }
  });
});
