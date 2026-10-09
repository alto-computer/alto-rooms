/*
 * Alto Rooms plugin SDK: the only Rooms code a plugin imports.
 *
 * A plugin runs in a sandboxed iframe with an opaque origin. It talks to the app
 * only through postMessage to `window.parent`, and trusts only messages whose
 * source is `window.parent` (an artifact iframe beside it could post too).
 * Every message carries `rooms: 1`.
 */

export type PluginContext = { slot: "artifact.sidePanel"; artifact: PluginArtifact } | { slot: "tab" };

export interface PluginRoom {
  id: string;
  name: string;
}

export interface PluginArtifact {
  roomId: string;
  artifactId: string;
  /** Stable key of the original file: the same across room moves and for every room that links it. */
  fileKey: string;
  title: string;
  createdAt: string;
}

export type PluginErrorCode =
  | "permission_denied"
  | "invalid_path"
  | "too_large"
  | "not_found"
  | "write_failed"
  | "unknown_method"
  | "rate_limited"
  | "timeout";

export class PluginError extends Error {
  code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string = code) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

export interface RoomsPlugin {
  readonly pluginId: string;
  /** Called at once with the current context, then on every change. Returns an unsubscribe. */
  onContext(cb: (ctx: PluginContext) => void): () => void;
  /** Runs before the plugin's frame closes (panel closed, tab left, app quitting, plugin updated). Keep it short. */
  onBeforeClose(cb: () => Promise<void> | void): () => void;
  storage: {
    /** The text at `path` under your data folder, or null when there is none. */
    read(path: string): Promise<string | null>;
    /** Writes atomically; at most 10 MB of UTF-8. */
    write(path: string, text: string): Promise<void>;
    /** Relative file paths under your data folder starting with `prefix`, sorted. */
    list(prefix?: string): Promise<string[]>;
    /** Removes a file; a missing file is fine. */
    delete(path: string): Promise<void>;
    /** Called with the path when a tool of yours or another frame of your plugin changed your data (not for this frame's own writes). Returns an unsubscribe. */
    onChange(cb: (path: string) => void): () => void;
  };
  /** Needs the `rooms.read` permission. */
  rooms: { list(): Promise<PluginRoom[]> };
  /** Needs the `rooms.read` permission. Newest first. */
  artifacts: { list(roomId: string): Promise<PluginArtifact[]> };
  /** Opens a room or a document in the current tab. */
  open(target: { roomId: string } | { fileKey: string }): Promise<void>;
}

type Inbound =
  | { rooms: 1; type: "context"; pluginId: string; context: PluginContext }
  | { rooms: 1; type: "beforeClose"; id: string }
  | { rooms: 1; type: "ping"; id: string }
  | { rooms: 1; type: "dataChanged"; path: string }
  | { rooms: 1; id: string; result?: unknown; error?: { code: PluginErrorCode; message?: string } };

export { connectContent, type ContentAction, type ContentSelection, type RoomsContent } from "./content";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Connects to the app: posts `ready` and resolves once the app sends the first context. */
export function connect(opts: { timeoutMs?: number } = {}): Promise<RoomsPlugin> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parent = window.parent;
  const post = (m: Record<string, unknown>) => parent.postMessage({ rooms: 1, ...m }, "*");

  let pluginId = "";
  let current: PluginContext | null = null;
  const contextListeners = new Set<(c: PluginContext) => void>();
  const changeListeners = new Set<(path: string) => void>();
  const closeHandlers = new Set<() => Promise<void> | void>();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: PluginError) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0;
  let onFirstContext: (() => void) | null = null;

  const request = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = `r${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PluginError("timeout", `${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      post({ id, method, params });
    });

  const runBeforeClose = async (id: string) => {
    await Promise.allSettled([...closeHandlers].map(async (h) => h()));
    post({ type: "beforeClose.done", id });
  };

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent) return;
    const d = e.data as Inbound | null;
    if (!d || typeof d !== "object" || d.rooms !== 1) return;
    if ("type" in d) {
      if (d.type === "context") {
        pluginId = d.pluginId;
        current = d.context;
        for (const l of [...contextListeners]) l(d.context);
        onFirstContext?.();
      } else if (d.type === "beforeClose") {
        void runBeforeClose(d.id);
      } else if (d.type === "ping") {
        post({ type: "pong", id: d.id });
      } else if (d.type === "dataChanged") {
        for (const l of [...changeListeners]) l(d.path);
      }
      return;
    }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.error) p.reject(new PluginError(d.error.code, d.error.message));
    else p.resolve(d.result);
  });

  const api: RoomsPlugin = {
    get pluginId() {
      return pluginId;
    },
    onContext(cb) {
      contextListeners.add(cb);
      if (current) cb(current);
      return () => void contextListeners.delete(cb);
    },
    onBeforeClose(cb) {
      closeHandlers.add(cb);
      return () => void closeHandlers.delete(cb);
    },
    storage: {
      read: (path) => request<string | null>("storage.read", { path }),
      write: (path, text) => request<void>("storage.write", { path, text }),
      list: (prefix = "") => request<string[]>("storage.list", { prefix }),
      delete: (path) => request<void>("storage.delete", { path }),
      onChange(cb) {
        changeListeners.add(cb);
        return () => void changeListeners.delete(cb);
      },
    },
    rooms: { list: () => request<PluginRoom[]>("rooms.list", {}) },
    artifacts: { list: (roomId) => request<PluginArtifact[]>("artifacts.list", { roomId }) },
    open: (target) => request<void>("open", target),
  };

  return new Promise<RoomsPlugin>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PluginError("timeout", "the app did not answer")), timeoutMs);
    onFirstContext = () => {
      onFirstContext = null;
      clearTimeout(timer);
      resolve(api);
    };
    post({ type: "ready" });
  });
}
