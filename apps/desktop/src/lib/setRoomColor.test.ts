import { createRoomsClient, type Room } from "@alto-rooms/protocol-ts";
import { afterEach, describe, expect, it, vi } from "vitest";

const pinned: Room = { id: "연구", name: "연구", kind: "owned", path: "/h/연구", status: "ok", artifactCount: 0, updatedAt: null, color: "sage" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client.setRoomColor", () => {
  it("PUTs the colour (or null to unpin) to the room's color route with the token, and returns the room", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(pinned), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRoomsClient("http://127.0.0.1:4317", "t0k");

    expect(await client.setRoomColor("연구", "sage")).toEqual(pinned);
    await client.setRoomColor("연구", null);

    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ["http://127.0.0.1:4317/v1/rooms/%EC%97%B0%EA%B5%AC/color", "PUT", '{"color":"sage"}'],
      ["http://127.0.0.1:4317/v1/rooms/%EC%97%B0%EA%B5%AC/color", "PUT", '{"color":null}'],
    ]);
    expect(calls[0][1].headers).toMatchObject({ authorization: "Bearer t0k", "content-type": "application/json" });
  });
});
