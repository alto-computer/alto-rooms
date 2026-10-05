import { afterEach, describe, expect, it } from "vitest";
import { resolveConnection } from "./connection";

type W = Window & { __ROOMS_DEV__?: unknown };

afterEach(() => {
  delete (window as W).__ROOMS_DEV__;
});

describe("resolveConnection", () => {
  it("rejects outside Tauri without __ROOMS_DEV__", async () => {
    await expect(resolveConnection()).rejects.toThrow();
  });

  it("returns window.__ROOMS_DEV__ outside Tauri", async () => {
    const conn = { baseUrl: "http://127.0.0.1:4317", token: "t", home: "/h" };
    (window as W).__ROOMS_DEV__ = conn;
    await expect(resolveConnection()).resolves.toEqual(conn);
  });
});
