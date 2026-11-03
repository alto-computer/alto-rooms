import { createRoomsClient, RoomsApiError } from "@alto-rooms/protocol-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, studyCard, studyVolume } from "@/test/fakes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client study methods", () => {
  it("call SPEC §7's routes with the token on writes", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRoomsClient("http://127.0.0.1:4317", "t0k");
    const save = { title: "t", cards: [studyCard("c1")], edges: [] };
    const day = { memos: [{ id: "m1", text: "왜?", at: "2026-11-03T09:00:00+09:00" }], todos: [] };

    await client.studyIndex();
    await client.createStudyRoom("판");
    await client.updateStudyRoom("abcde12345", { name: "판", links: [{ kind: "room", roomId: "inbox" }] });
    await client.studyVolume("abcde12345", 2);
    await client.saveStudyVolume("abcde12345", 2, save);
    await client.publishStudyRoom("abcde12345");
    await client.studyDay("2026-11-03");
    await client.saveStudyDay("2026-11-03", day);

    const calls = fetch.mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls.map(([url, init]) => [url.replace("http://127.0.0.1:4317", ""), init?.method ?? "GET", init?.body])).toEqual([
      ["/v1/study", "GET", undefined],
      ["/v1/study/rooms", "POST", '{"name":"판"}'],
      ["/v1/study/rooms/abcde12345", "PUT", '{"name":"판","links":[{"kind":"room","roomId":"inbox"}]}'],
      ["/v1/study/rooms/abcde12345/volumes/2", "GET", undefined],
      ["/v1/study/rooms/abcde12345/volumes/2", "PUT", JSON.stringify(save)],
      ["/v1/study/rooms/abcde12345/publish", "POST", ""],
      ["/v1/study/days/2026-11-03", "GET", undefined],
      ["/v1/study/days/2026-11-03", "PUT", JSON.stringify(day)],
    ]);
    for (const [, init] of calls.filter(([, init]) => init?.method)) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer t0k" });
    }
  });

  it("surface roomsd's error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"volume_published","message":"volume is published"}', { status: 409 })));
    const client = createRoomsClient("http://127.0.0.1:4317", "t0k");
    await expect(client.saveStudyVolume("abcde12345", 1, { title: "", cards: [], edges: [] })).rejects.toMatchObject({ status: 409, code: "volume_published" });
  });
});

describe("fake client study", () => {
  it("keeps one draft per room, freezes published volumes and copies cards forward", async () => {
    const { client } = fakeClient();
    const room = await client.createStudyRoom("  판의 이해 ");
    expect(room.id).toMatch(/^[a-z0-9]{10}$/);
    expect(room).toMatchObject({ name: "판의 이해", links: [], volumes: [{ number: 1, status: "draft", title: "" }] });

    const cards = [studyCard("c1", { body: "# 제목" }), studyCard("c2", { kind: "question" })];
    await client.saveStudyVolume(room.id, 1, { title: "첫 판", cards, edges: [{ id: "e1", source: "c1", target: "c2" }] });
    const after = await client.publishStudyRoom(room.id);
    expect(after.volumes.map((v) => [v.number, v.status, v.title])).toEqual([
      [1, "published", "첫 판"],
      [2, "draft", ""],
    ]);
    expect((await client.studyVolume(room.id, 2)).cards).toEqual(cards);
    await expect(client.saveStudyVolume(room.id, 1, { title: "", cards: [], edges: [] })).rejects.toMatchObject({ code: "volume_published" });
    await expect(client.studyVolume(room.id, 3)).rejects.toMatchObject({ code: "volume_not_found" });
    await expect(client.studyVolume("zzzzzzzzzz", 1)).rejects.toBeInstanceOf(RoomsApiError);
    await expect(client.createStudyRoom(" ")).rejects.toMatchObject({ code: "invalid_input" });
    expect((await client.studyIndex()).rooms.map((r) => r.id)).toEqual([room.id]);
  });

  it("reads seeded rooms and days, and an unsaved day as empty", async () => {
    const { client } = fakeClient({
      studyRooms: [{ id: "abcde12345", name: "r", createdAt: "2026-11-01T09:00:00+09:00", links: [], volumes: [studyVolume(1, { publishedAt: "2026-11-02T09:00:00+09:00" }), studyVolume(2)] }],
    });
    expect((await client.studyIndex()).rooms[0].volumes.map((v) => v.status)).toEqual(["published", "draft"]);
    expect(await client.studyDay("2026-11-03")).toEqual({ date: "2026-11-03", memos: [], todos: [] });
    const todos = [{ id: "t1", text: "발행", done: true, at: "2026-11-03T09:00:00+09:00" }];
    await client.saveStudyDay("2026-11-03", { memos: [], todos });
    expect((await client.studyDay("2026-11-03")).todos).toEqual(todos);
  });
});
