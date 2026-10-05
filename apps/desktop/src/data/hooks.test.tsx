import type { Artifact, RoomsEvent } from "@alto-rooms/protocol-ts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StoresProvider, useArtifacts, useRooms, useViewer } from "./hooks";
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
  source: { agent: null, session: null, cwd: null, machine: null },
};

function client() {
  let emit: (e: RoomsEvent) => void = () => {};
  const c: RoomsClientLike = {
    info: async () => ({ version: "0", readOnly: false, home: "/h", journalRoomId: "j", filesOrigin: "http://f" }),
    listRooms: async () => ({ data: [{ id: "r1", name: "Room one", kind: "owned", path: "/h/r1", status: "ok", artifactCount: 1, updatedAt: null }], seq: 1 }),
    listArtifacts: async () => ({ data: [a1], seq: 1 }),
    journalDay: async (date) => ({ data: { date, artifacts: [], notes: [] }, seq: 1 }),
    subscribe: (onEvent) => {
      emit = onEvent;
      return () => {};
    },
  };
  return { c, emit: (e: RoomsEvent) => emit(e) };
}

function Probe() {
  const { status, rooms } = useRooms();
  const arts = useArtifacts("r1");
  const viewer = useViewer();
  return (
    <p>
      {status}|{rooms.map((r) => r.name).join(",")}|{arts?.map((a) => a.title).join(",") ?? "loading"}|{viewer.tabs.length}
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
    });
    expect(await screen.findByText("live|Room one|First|1")).toBeTruthy();
    act(() => emit({ seq: 2, type: "artifact.added", artifact: { ...a1, id: "a2", title: "Second", createdAt: "2026-10-05T01:00:00Z" } }));
    expect(screen.getByText("live|Room one|First,Second|1")).toBeTruthy();
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
