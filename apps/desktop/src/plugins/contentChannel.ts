/*
 * The app side of content scripts: messages between one doc frame and the
 * content scripts roomsd spliced into it. Everything from the frame is
 * untrusted, because the document's own script shares the window and can post
 * anything a content script can. So the host takes the document's fileKey from
 * the tab, never from a message, and maps every storage path under
 * `docs/<fileKey>/` in the named plugin's data. A hostile document can at most
 * read or rewrite that folder for the plugins the user turned on.
 */
import { BridgeError, relay, validPath, type BridgeDeps, type BridgeErrorCode } from "./bridge";
import { pluginDataBus } from "./pluginDataBus";

/** Largest text one content-script write may store (UTF-8 bytes). */
export const MAX_CONTENT_WRITE_BYTES = 1024 * 1024;
/** Writes and deletes one doc frame may make in any one second. */
export const MAX_WRITES_PER_SECOND = 20;
export const MAX_ACTIONS = 6;
export const MAX_ACTION_TITLE = 24;

export type ContentAction = { id: string; title: string; color?: string };

type StorageMethod = "storage.read" | "storage.write" | "storage.list" | "storage.delete";

/** A frame message that passed the envelope check. Storage arguments are checked when handled, so a bad one gets an error reply. */
export type FrameMessage =
  | { type: "ready"; plugin: string }
  | { type: "actions"; plugin: string; items: ContentAction[] }
  | { type: StorageMethod; plugin: string; id: string; path: unknown; text: unknown; prefix: unknown };

export type HostMessage =
  | { type: "reply"; plugin: string; id: string; result: unknown }
  | { type: "reply"; plugin: string; id: string; error: { code: BridgeErrorCode; message: string } }
  | { type: "dataChanged"; plugin: string; path: string }
  | { type: "selection.action"; plugin: string; actionId: string };

const STORAGE = new Set<string>(["storage.read", "storage.write", "storage.list", "storage.delete"]);

const isColor = (v: string): boolean => typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("color", v);

function parseActions(items: unknown, validColor: (v: string) => boolean): ContentAction[] | null {
  if (!Array.isArray(items) || items.length > MAX_ACTIONS) return null;
  const out: ContentAction[] = [];
  for (const it of items as unknown[]) {
    if (!it || typeof it !== "object") return null;
    const { id, title, color } = it as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 64 || out.some((a) => a.id === id)) return null;
    if (typeof title !== "string" || !title.trim()) return null;
    if (color !== undefined && (typeof color !== "string" || color.length > 64 || !validColor(color))) return null;
    out.push({ id, title: title.trim().slice(0, MAX_ACTION_TITLE), ...(color === undefined ? {} : { color }) });
  }
  return out;
}

/** `{rooms: "content", v: 1, plugin, type, …}` from a doc frame, or null for anything else. */
export function parseFrameMessage(data: unknown, validColor: (v: string) => boolean = isColor): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.rooms !== "content" || d.v !== 1 || typeof d.plugin !== "string" || typeof d.type !== "string") return null;
  const plugin = d.plugin;
  if (d.type === "ready") return { type: "ready", plugin };
  if (d.type === "actions") {
    const items = parseActions(d.items, validColor);
    return items ? { type: "actions", plugin, items } : null;
  }
  if (STORAGE.has(d.type) && typeof d.id === "string" && d.id.length <= 64) {
    return { type: d.type as StorageMethod, plugin, id: d.id, path: d.path, text: d.text, prefix: d.prefix };
  }
  return null;
}

export type ContentChannelDeps = {
  fileKey: string;
  /** The usable plugins that hold `artifact.content`: the set the frame URL's contentKey was built from. */
  plugins: ReadonlySet<string>;
  /** The doc frame's window: the only source the channel listens to and the only target it posts to. */
  frame: () => Window | null;
  client: Pick<BridgeDeps["client"], "getPluginData" | "putPluginData" | "listPluginData" | "deletePluginData">;
  /** Every plugin's declared actions, after each change. */
  onActions: (actions: ReadonlyMap<string, ContentAction[]>) => void;
  now?: () => number;
  validColor?: (v: string) => boolean;
};

export type ContentChannel = {
  /** Handles one window `message` event; ignores events from any window but the doc frame. */
  receive(e: MessageEvent): void;
  /** Tells `plugin`'s content script that its action was clicked; only an action it declared. */
  runAction(plugin: string, actionId: string): void;
  /** Messages from the doc frame that were malformed or named a plugin outside the set. */
  readonly dropped: number;
  dispose(): void;
};

export function createContentChannel(deps: ContentChannelDeps): ContentChannel {
  const { fileKey, plugins, frame, client } = deps;
  const now = deps.now ?? (() => performance.now());
  const validColor = deps.validColor ?? isColor;
  const base = `docs/${fileKey}/`;
  const actions = new Map<string, ContentAction[]>();
  const recentWrites: number[] = [];
  let dropped = 0;

  const post = (m: HostMessage) => frame()?.postMessage({ rooms: "content", v: 1, ...m }, "*");

  const docPath = (p: unknown): string => {
    if (!validPath(p) || !validPath(base + p)) throw new BridgeError("invalid_path");
    return base + p;
  };

  const takeWriteSlot = () => {
    const t = now();
    while (recentWrites.length && t - recentWrites[0] >= 1000) recentWrites.shift();
    if (recentWrites.length >= MAX_WRITES_PER_SECOND) throw new BridgeError("rate_limited", `more than ${MAX_WRITES_PER_SECOND} writes in one second`);
    recentWrites.push(t);
  };

  const changed = (plugin: string, path: string) => pluginDataBus.publish({ pluginId: plugin, path, from: frame() });

  async function storage(m: Extract<FrameMessage, { id: string }>): Promise<unknown> {
    switch (m.type) {
      case "storage.read":
        return relay(client.getPluginData(m.plugin, docPath(m.path)));
      case "storage.write": {
        const path = docPath(m.path);
        if (typeof m.text !== "string") throw new BridgeError("invalid_path", "text must be a string");
        if (new TextEncoder().encode(m.text).length > MAX_CONTENT_WRITE_BYTES) throw new BridgeError("too_large");
        takeWriteSlot();
        await relay(client.putPluginData(m.plugin, path, m.text));
        changed(m.plugin, path);
        return null;
      }
      case "storage.list": {
        const prefix = m.prefix ?? "";
        if (typeof prefix !== "string" || (prefix !== "" && !validPath(prefix.replace(/\/$/, "")))) throw new BridgeError("invalid_path");
        const found = await relay(client.listPluginData(m.plugin, base + prefix));
        return found.filter((p) => p.startsWith(base)).map((p) => p.slice(base.length));
      }
      case "storage.delete": {
        const path = docPath(m.path);
        takeWriteSlot();
        await relay(client.deletePluginData(m.plugin, path));
        changed(m.plugin, path);
        return null;
      }
    }
  }

  const stopBus = pluginDataBus.subscribe((c) => {
    if (!plugins.has(c.pluginId) || !c.path.startsWith(base)) return;
    const win = frame();
    if (!win || c.from === win) return;
    post({ type: "dataChanged", plugin: c.pluginId, path: c.path.slice(base.length) });
  });

  return {
    receive(e) {
      const win = frame();
      if (!win || e.source !== win) return;
      const d = e.data as { rooms?: unknown } | null;
      if (!d || typeof d !== "object" || d.rooms !== "content") return;
      const m = parseFrameMessage(d, validColor);
      if (!m || !plugins.has(m.plugin)) {
        dropped++;
        return;
      }
      if (m.type === "ready") return;
      if (m.type === "actions") {
        actions.set(m.plugin, m.items);
        deps.onActions(new Map(actions));
        return;
      }
      const { plugin, id } = m;
      storage(m).then(
        (result) => post({ type: "reply", plugin, id, result: result ?? null }),
        (err: unknown) =>
          post({
            type: "reply",
            plugin,
            id,
            error: {
              code: err instanceof BridgeError ? err.code : "write_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          }),
      );
    },
    runAction(plugin, actionId) {
      if (actions.get(plugin)?.some((a) => a.id === actionId)) post({ type: "selection.action", plugin, actionId });
    },
    get dropped() {
      return dropped;
    },
    dispose: stopBus,
  };
}
