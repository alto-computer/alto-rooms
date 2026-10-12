import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, connectSurfaces, type RoomsTheme } from "./index";

function fakeParent() {
  const sent: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => void sent.push(m) } as unknown as Window;
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const deliver = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  return { sent, parent, deliver };
}

const light: RoomsTheme = { scheme: "light", tokens: { bg: "#f8f4ee", text: "#27211e", "font-sans": 'system-ui, "SF Pro Text", sans-serif', shadow: "0 1px 1px rgb(70 45 20 / .05)" } };
const dark: RoomsTheme = { scheme: "dark", tokens: { bg: "#211c19", text: "#efe7df" } };
const themeMessage = (t: RoomsTheme) => ({ rooms: 1, type: "theme", ...t });

const root = () => document.documentElement;
const roomsVar = (name: string) => root().style.getPropertyValue(`--rooms-${name}`);
const defaultRule = () => document.getElementById("rooms-theme")?.textContent ?? null;

let host: ReturnType<typeof fakeParent>;
beforeEach(() => {
  host = fakeParent();
});
afterEach(() => {
  root().removeAttribute("style");
  delete root().dataset.roomsScheme;
  document.getElementById("rooms-theme")?.remove();
});

async function connected(opts?: { theme?: boolean }) {
  const p = connect(opts);
  host.deliver({ rooms: 1, type: "context", pluginId: "echo", context: { slot: "tab" } });
  return p;
}

describe("theme on connect()", () => {
  it("puts each token on <html> as --rooms-<name>, sets color-scheme, and gives the page the app's colours", async () => {
    const rooms = await connected();
    host.deliver(themeMessage(light));
    expect(roomsVar("bg")).toBe("#f8f4ee");
    expect(roomsVar("text")).toBe("#27211e");
    expect(roomsVar("font-sans")).toBe('system-ui, "SF Pro Text", sans-serif');
    expect(roomsVar("shadow")).toBe("0 1px 1px rgb(70 45 20 / .05)");
    expect(root().style.getPropertyValue("color-scheme")).toBe("light");
    expect(root().dataset.roomsScheme).toBe("light");
    expect(defaultRule()).toBe(":where(html){background:var(--rooms-bg);color:var(--rooms-text)}");
    expect(rooms.theme.current()).toEqual(light);
  });

  it("follows the next theme: new values replace old ones, a token no longer sent is removed, and the default rule stays single", async () => {
    await connected();
    host.deliver(themeMessage(light));
    host.deliver(themeMessage(dark));
    expect(roomsVar("bg")).toBe("#211c19");
    expect(roomsVar("font-sans")).toBe("");
    expect(root().style.getPropertyValue("color-scheme")).toBe("dark");
    expect(document.querySelectorAll("#rooms-theme")).toHaveLength(1);
  });

  it("onChange fires at once when a theme is known, then on every change, until unsubscribed", async () => {
    const rooms = await connected();
    const before: RoomsTheme[] = [];
    rooms.theme.onChange((t) => before.push(t));
    expect(before).toEqual([]);
    host.deliver(themeMessage(light));
    const after: RoomsTheme[] = [];
    const off = rooms.theme.onChange((t) => after.push(t));
    host.deliver(themeMessage(dark));
    off();
    host.deliver(themeMessage(light));
    expect(before).toEqual([light, dark, light]);
    expect(after).toEqual([light, dark]);
  });

  it("with theme: false leaves the page alone but still reports the theme", async () => {
    const rooms = await connected({ theme: false });
    host.deliver(themeMessage(light));
    expect(root().getAttribute("style")).toBeNull();
    expect(defaultRule()).toBeNull();
    expect(rooms.theme.current()).toEqual(light);
  });

  it("drops a token it does not know or cannot read as a plain value, and ignores a message with an unknown scheme or from another window", async () => {
    const rooms = await connected();
    host.deliver({
      rooms: 1,
      type: "theme",
      scheme: "light",
      tokens: { bg: "#fff", evil: "#000", text: "red; } body { display: none", card: "url(http://x/y.png)", border: 42, accent: "x".repeat(513) },
    });
    expect(rooms.theme.current()).toEqual({ scheme: "light", tokens: { bg: "#fff" } });
    expect(root().style.getPropertyValue("--rooms-evil")).toBe("");
    expect(roomsVar("text")).toBe("");
    expect(roomsVar("card")).toBe("");
    host.deliver({ rooms: 1, type: "theme", scheme: "sepia", tokens: { bg: "#000" } });
    host.deliver(themeMessage(dark), { postMessage() {} });
    expect(rooms.theme.current()).toEqual({ scheme: "light", tokens: { bg: "#fff" } });
    expect(roomsVar("bg")).toBe("#fff");
  });
});

describe("theme on connectSurfaces()", () => {
  it("applies the theme to a page that only connects its surfaces", () => {
    connectSurfaces();
    host.deliver(themeMessage(dark));
    expect(roomsVar("bg")).toBe("#211c19");
    expect(root().style.getPropertyValue("color-scheme")).toBe("dark");
  });
});
