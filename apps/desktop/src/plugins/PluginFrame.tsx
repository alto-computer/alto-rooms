/*
 * One plugin, running: a sandboxed iframe from the plugin's folder plus the
 * app side of the bridge. Trusts only messages whose source is this frame's
 * window; sends the slot's context on ready and on change; relays requests;
 * pings to notice a stuck plugin; and lets its owner ask for beforeClose.
 */
import type { Info } from "@alto-rooms/protocol-ts";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useClient, useRoomsStore, useViewerStore } from "@/data/hooks";
import { BridgeError, handleBridgeCall } from "./bridge";
import { registerFrame } from "./host";
import { frameAttrs } from "./permissions";
import type { HostPlugin } from "./pluginsStore";

export type PluginContextValue =
  | { slot: "artifact.sidePanel"; artifact: { roomId: string; artifactId: string; fileKey: string; title: string; createdAt: string } }
  | { slot: "tab" };

export type PluginFrameHandle = { beforeClose(capMs?: number): Promise<void> };

const PING_EVERY_MS = 5000;
const PONG_WITHIN_MS = 3000;
export const CLOSE_CAP_MS = 1500;

type Inbound = { rooms?: unknown; type?: unknown; id?: unknown; method?: unknown; params?: unknown };

export const PluginFrame = forwardRef<PluginFrameHandle, { plugin: HostPlugin; info: Info; context: PluginContextValue }>(
  function PluginFrame({ plugin, info, context }, ref) {
    const client = useClient();
    const viewer = useViewerStore();
    const rooms = useRoomsStore();
    const frameRef = useRef<HTMLIFrameElement>(null);
    const [reload, setReload] = useState(0);
    const [stalled, setStalled] = useState(false);
    const ready = useRef(false);
    const latest = useRef({ plugin, context });
    latest.current = { plugin, context };
    const waiters = useRef(new Map<string, () => void>());
    const seq = useRef(0);

    const post = useCallback((m: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage({ rooms: 1, ...m }, "*");
    }, []);
    const sendContext = useCallback(() => {
      post({ type: "context", pluginId: latest.current.plugin.id, context: latest.current.context });
    }, [post]);

    /** Posts `{type, id}` and resolves when the frame answers with `reply` for that id, or after `capMs`. */
    const ask = useCallback(
      (type: string, capMs: number): Promise<boolean> =>
        new Promise((resolve) => {
          const id = `${type}-${++seq.current}`;
          const timer = setTimeout(() => {
            waiters.current.delete(id);
            resolve(false);
          }, capMs);
          waiters.current.set(id, () => {
            clearTimeout(timer);
            waiters.current.delete(id);
            resolve(true);
          });
          post({ type, id });
        }),
      [post],
    );

    const beforeClose = useCallback(
      async (capMs = CLOSE_CAP_MS) => {
        if (!ready.current) return;
        await ask("beforeClose", capMs);
      },
      [ask],
    );
    useImperativeHandle(ref, () => ({ beforeClose }), [beforeClose]);

    useEffect(() => {
      const onMessage = (e: MessageEvent) => {
        const win = frameRef.current?.contentWindow;
        if (!win || e.source !== win) return;
        const d = e.data as Inbound | null;
        if (!d || typeof d !== "object" || d.rooms !== 1) return;
        if (d.type === "ready") {
          ready.current = true;
          setStalled(false);
          sendContext();
          return;
        }
        if ((d.type === "pong" || d.type === "beforeClose.done") && typeof d.id === "string") {
          waiters.current.get(d.id)?.();
          return;
        }
        if (typeof d.id !== "string" || typeof d.method !== "string") return;
        const id = d.id;
        handleBridgeCall(
          latest.current.plugin,
          { id, method: d.method, params: d.params },
          {
            client,
            navigate: (t) => viewer.navigate(t),
            rooms: () => rooms.getState().rooms,
          },
        ).then(
          (result) => post({ id, result: result ?? null }),
          (err: unknown) =>
            post({
              id,
              error: {
                code: err instanceof BridgeError ? err.code : "write_failed",
                message: err instanceof Error ? err.message : String(err),
              },
            }),
        );
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [client, viewer, rooms, post, sendContext]);

    // A new context (another document in the same panel) goes to a frame that is already up.
    const contextKey = JSON.stringify(context);
    useEffect(() => {
      if (ready.current) sendContext();
    }, [contextKey, sendContext]);

    // Liveness: ping every 5 s once ready; no pong within 3 s → stalled.
    useEffect(() => {
      if (stalled) return;
      const t = setInterval(() => {
        if (!ready.current) return;
        void ask("ping", PONG_WITHIN_MS).then((ok) => {
          if (!ok) setStalled(true);
        });
      }, PING_EVERY_MS);
      return () => clearInterval(t);
    }, [stalled, ask, reload]);

    // Quit flush can reach this frame; on unmount it still gets a (best-effort) beforeClose.
    useEffect(() => {
      const off = registerFrame({ pluginId: plugin.id, beforeClose });
      return () => {
        off();
        if (ready.current) post({ type: "beforeClose", id: `unmount-${++seq.current}` });
      };
    }, [plugin.id, beforeClose, post]);

    const attrs = frameAttrs(plugin);
    return (
      <div className="relative min-h-0 flex-1 bg-white">
        <iframe
          key={`${plugin.rev}:${reload}`}
          ref={frameRef}
          title={plugin.name}
          src={client.pluginEntryUrl(info, plugin)}
          sandbox={attrs.sandbox}
          allow={attrs.allow}
          className="absolute inset-0 size-full border-0 bg-white"
        />
        {stalled ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/95 text-[15px] text-ink-2">
            <p>This plugin stopped responding</p>
            <button
              type="button"
              onClick={() => {
                ready.current = false;
                setStalled(false);
                setReload((n) => n + 1);
              }}
              className="rounded-lg border border-[#ddd] bg-white px-3 py-1.5 text-[14px] text-ink hover:bg-[#f7f7f7] focus-visible:outline-2 focus-visible:outline-ink"
            >
              Reload
            </button>
          </div>
        ) : null}
      </div>
    );
  },
);
