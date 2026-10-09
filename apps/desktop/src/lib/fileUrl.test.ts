import { createRoomsClient, type Artifact, type Info } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";

const info = { filesOrigin: "http://127.0.0.1:4318" } as Info;
const doc = (updatedAt: string) => ({ roomId: "연구", relPath: "sub/a b.html", updatedAt }) as Artifact;

describe("client.fileUrl", () => {
  it("encodes each path part and versions the URL by updatedAt, so a changed file reloads", () => {
    const client = createRoomsClient("http://127.0.0.1:4317", "t");
    const before = client.fileUrl(info, doc("2026-10-07T10:00:00.000+09:00"));
    expect(before).toBe("http://127.0.0.1:4318/%EC%97%B0%EA%B5%AC/sub/a%20b.html?v=2026-10-07T10%3A00%3A00.000%2B09%3A00");
    expect(client.fileUrl(info, doc("2026-10-07T10:00:01.000+09:00"))).not.toBe(before);
  });

  it("asks for the doc variant with its content key, so a plugin toggle reloads the frame", () => {
    const client = createRoomsClient("http://127.0.0.1:4317", "t");
    const d = doc("2026-10-07T10:00:00.000+09:00");
    expect(client.fileUrl(info, d, { contentKey: "a1b2" })).toBe(`${client.fileUrl(info, d)}&doc=1&cs=a1b2`);
    expect(client.fileUrl(info, d, { contentKey: "c3d4" })).not.toBe(client.fileUrl(info, d, { contentKey: "a1b2" }));
  });
});
