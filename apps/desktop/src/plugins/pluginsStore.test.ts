import type { PluginInfo, RoomsEvent } from "@alto-rooms/protocol-ts";
import { describe, expect, it, vi } from "vitest";
import { compatible, PluginsStore } from "./pluginsStore";
import { plugin } from "@/test/plugins";

function setup(list: PluginInfo[], appVersion = "0.3.0") {
  let signal: (e: RoomsEvent["type"]) => void = () => {};
  const client = {
    listPlugins: vi.fn(async () => list),
    setPluginEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const p = list.find((x) => x.id === id)!;
      p.enabled = enabled;
      p.needsApproval = !enabled;
      return p;
    }),
  };
  const rooms = { onSignal: (fn: (e: RoomsEvent["type"]) => void) => ((signal = fn), () => {}) };
  const store = new PluginsStore(client, rooms, appVersion);
  return { store, client, signal: (e: RoomsEvent["type"]) => signal(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("compatible", () => {
  it("compares semver cores", () => {
    expect(compatible("0.3.0", "0.3.0")).toBe(true);
    expect(compatible("0.3.1", "0.3.0")).toBe(true);
    expect(compatible("1.0.0", "0.9.9")).toBe(true);
    expect(compatible("0.2.9", "0.3.0")).toBe(false);
    expect(compatible("0.3.0", "0.10.0")).toBe(false);
  });
});

describe("PluginsStore", () => {
  it("loads on start and marks incompatible plugins", async () => {
    const { store } = setup([plugin({ id: "a" }), plugin({ id: "b", minAppVersion: "9.0.0" })]);
    store.start();
    await flush();
    expect(store.getState().list.map((p) => [p.id, p.compatible])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("lists again on plugins.changed and on resync, not on other events", async () => {
    const { store, client, signal } = setup([plugin()]);
    store.start();
    await flush();
    signal("plugins.changed");
    signal("resync");
    signal("room.added");
    await flush();
    expect(client.listPlugins).toHaveBeenCalledTimes(3);
  });

  it("setEnabled writes then lists again", async () => {
    const { store, client } = setup([plugin({ enabled: false, needsApproval: true })]);
    store.start();
    await flush();
    await store.setEnabled("echo", true);
    expect(client.setPluginEnabled).toHaveBeenCalledWith("echo", true, undefined);
    expect(store.getState().list[0].enabled).toBe(true);
  });

  it("asks about one plugin at a time, by id, skipping invalid, incompatible and dismissed ones", async () => {
    const { store } = setup([
      plugin({ id: "zed", enabled: false, needsApproval: true }),
      plugin({ id: "bad", status: "invalid", needsApproval: false, enabled: false }),
      plugin({ id: "new", enabled: false, needsApproval: true, minAppVersion: "9.0.0" }),
      plugin({ id: "abc", enabled: false, needsApproval: true }),
    ]);
    store.start();
    await flush();
    expect(store.nextToApprove()?.id).toBe("abc");
    store.dismiss("abc");
    expect(store.nextToApprove()?.id).toBe("zed");
    store.dismiss("zed");
    expect(store.nextToApprove()).toBeNull();
  });

  it("usable = ok, compatible, enabled and approved", async () => {
    const { store } = setup([plugin({ id: "on" }), plugin({ id: "off", enabled: false, needsApproval: true })]);
    store.start();
    await flush();
    expect(
      store
        .getState()
        .list.filter((p) => store.usable(p))
        .map((p) => p.id),
    ).toEqual(["on"]);
  });
});
