/*
 * The content-script side of the SDK. A plugin that declares `artifact.content`
 * and `contentScripts` has those scripts loaded into every document a doc tab
 * shows, inside the document's own sandbox. They talk to the app by
 * postMessage to `window.parent` with `rooms: "content"`, and trust only
 * messages whose source is `window.parent`: the document's own script shares
 * this window and can post to it.
 */
import { PluginError, type PluginErrorCode } from "./errors";

/** A button in the app's selection bar, shown after Ask while text is selected in the document. */
export interface ContentAction {
  id: string;
  /** Cut to 24 characters. */
  title: string;
  /** Any CSS color; shown as a dot before the title. */
  color?: string;
}

/** What was selected in the document when the action was clicked. */
export interface ContentSelection {
  text: string;
  range: Range;
}

export interface RoomsContent {
  readonly pluginId: string;
  /**
   * Your data for this document only: the app keeps it under `docs/<fileKey>/` in your plugin's
   * data, the same for every room that links the document. The document itself can also write it.
   */
  storage: {
    read(path: string): Promise<string | null>;
    /** At most 1 MiB of UTF-8, and 20 writes or deletes a second. */
    write(path: string, text: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
    delete(path: string): Promise<void>;
  };
  /** Replaces this plugin's buttons in the selection bar; at most 6. */
  setActions(items: ContentAction[]): void;
  /**
   * Called when one of your buttons is clicked, with the last selection made in this document:
   * clicking the bar can clear the live selection first. Returns an unsubscribe.
   */
  onAction(cb: (actionId: string, selection: ContentSelection | null) => void): () => void;
  /** Called with the path (relative to this document) when another frame of your plugin changed it. */
  onDataChanged(cb: (path: string) => void): () => void;
  /** Tells the app this script is listening. */
  ready(): void;
}

type Inbound =
  | { type: "reply"; id: string; result?: unknown; error?: { code: PluginErrorCode; message?: string } }
  | { type: "dataChanged"; path: string }
  | { type: "selection.action"; actionId: string };

const TIMEOUT_MS = 10_000;

export function connectContent(pluginId: string, opts: { timeoutMs?: number } = {}): RoomsContent {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const parent = window.parent;
  const post = (m: Record<string, unknown>) => parent.postMessage({ rooms: "content", v: 1, plugin: pluginId, ...m }, "*");
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: PluginError) => void; timer: ReturnType<typeof setTimeout> }>();
  const actionListeners = new Set<(id: string, s: ContentSelection | null) => void>();
  const changeListeners = new Set<(path: string) => void>();
  let nextId = 0;
  let last: Range | null = null;

  document.addEventListener("selectionchange", () => {
    const s = document.getSelection();
    if (s && !s.isCollapsed && s.rangeCount > 0) last = s.getRangeAt(0).cloneRange();
  });

  const request = <T>(type: string, params: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = `${pluginId}-${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PluginError("timeout", `${type} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      post({ type, id, ...params });
    });

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent) return;
    const d = e.data as ({ rooms?: unknown; v?: unknown; plugin?: unknown } & Inbound) | null;
    if (!d || typeof d !== "object" || d.rooms !== "content" || d.v !== 1 || d.plugin !== pluginId) return;
    if (d.type === "reply") {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.error) p.reject(new PluginError(d.error.code, d.error.message));
      else p.resolve(d.result);
    } else if (d.type === "dataChanged") {
      for (const l of [...changeListeners]) l(d.path);
    } else if (d.type === "selection.action") {
      const sel = last ? { text: last.toString(), range: last } : null;
      for (const l of [...actionListeners]) l(d.actionId, sel);
    }
  });

  return {
    pluginId,
    storage: {
      read: (path) => request<string | null>("storage.read", { path }),
      write: (path, text) => request<void>("storage.write", { path, text }),
      list: (prefix = "") => request<string[]>("storage.list", { prefix }),
      delete: (path) => request<void>("storage.delete", { path }),
    },
    setActions: (items) => post({ type: "actions", items }),
    onAction(cb) {
      actionListeners.add(cb);
      return () => void actionListeners.delete(cb);
    },
    onDataChanged(cb) {
      changeListeners.add(cb);
      return () => void changeListeners.delete(cb);
    },
    ready: () => post({ type: "ready" }),
  };
}
