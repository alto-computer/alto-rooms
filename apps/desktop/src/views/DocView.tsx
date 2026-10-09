import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useArtifacts, useAsksStore, useClient, useInfo, usePlugins, useReadOnly, useRoomList, useScopeError, useViewerStore } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { PluginSlot, SidePanelOpener } from "@/plugins/PluginSlot";
import { createContentChannel, newFrameSession, type ContentAction, type ContentChannel, type ContentChannelDeps } from "@/plugins/contentChannel";
import { contentKey, contentPlugins, type HostPlugin } from "@/plugins/pluginsStore";
import { ToolbarGroup } from "@/components/ToolbarGroup";
import { useCurrentTabId, useTabVisible } from "@/shell/currentTab";
import { AskBar } from "@/ask/AskBar";
import { askAction, SelectionBar, type SelectionAction } from "@/selection/SelectionBar";
import { readSelectionMessage, type SelectionRect } from "@/selection/useTextSelection";
import { DocSkeleton } from "./DocSkeleton";
import { ShareMenu } from "./ShareMenu";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-white p-12 text-center text-[17px] text-ink-2">{children}</div>;
}

/**
 * A doc tab: one artifact, full size, in a sandboxed iframe from the files
 * origin. Watches the artifact's room so a removal shows the "gone" copy.
 */
export function DocView({ roomId, artifactId }: { roomId: string; artifactId: string }) {
  const info = useInfo();
  const rooms = useRoomList();
  const client = useClient();
  const [loaded, setLoaded] = useState(false);
  const artifacts = useArtifacts(roomId);
  const loadError = useScopeError(`room:${roomId}`);
  const visible = useTabVisible();
  const frame = useRef<HTMLIFrameElement>(null);
  const selection = useDocSelection(frame);
  const asks = useAsksStore();
  const readOnly = useReadOnly();
  const plugins = usePlugins();
  const artifact = artifacts?.find((a) => a.id === artifactId);
  const src = info && artifact ? client.fileUrl(info, artifact, { contentKey: contentKey(plugins.list) }) : undefined;
  const content = useContentChannel(frame, src, artifact?.fileKey, plugins.list, client);

  // The store forgets a removed room's artifacts; its documents are gone too.
  const roomGone = info !== null && roomId !== info.journalRoomId && !rooms.some((r) => r.id === roomId);
  if (roomGone) return <Centered>This doc is gone</Centered>;
  if (artifacts === undefined) {
    return loadError ? <Centered>{GENERIC_ERROR}</Centered> : <div className="flex-1 bg-white" />;
  }
  if (!artifact) return <Centered>This doc is gone</Centered>;
  if (!info) return <div className="flex-1 bg-white" />;

  return (
    <div className="relative flex min-h-0 flex-1 bg-white">
      <div className="relative min-w-0 flex-1">
        {/* No allow-same-origin: a doc is agent-written HTML and must never reach the app. What
            it shares comes out by postMessage only: the selection bridge roomsd splices in, and
            the content scripts of the plugins the user turned on, which the doc variant adds. */}
        <iframe
          title={artifact.title}
          ref={frame}
          src={src}
          sandbox="allow-scripts allow-popups"
          onLoad={() => setLoaded(true)}
          className={cn("absolute inset-0 size-full border-0 bg-white transition-opacity duration-300 ease-out motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
        />
        {loaded ? null : <DocSkeleton />}
        {selection.current ? (
          <SelectionBar
            rect={selection.current.rect}
            actions={[
              ...(readOnly
                ? []
                : [
                    askAction(() => {
                      asks.addQuote({ kind: "doc", fileKey: artifact.fileKey }, selection.current!.text);
                      selection.dismiss();
                    }),
                  ]),
              ...content.actions.map(
                (a): SelectionAction => ({
                  key: `${a.plugin}:${a.id}`,
                  title: a.title,
                  color: a.color,
                  run: () => {
                    content.run(a.plugin, a.id);
                    selection.dismiss();
                  },
                }),
              ),
            ]}
          />
        ) : null}
        <AskBar subject={{ kind: "doc", artifact }} />
        <ToolbarGroup label="Document actions">
          <ShareMenu artifact={artifact} />
          {visible ? <SidePanelOpener /> : null}
        </ToolbarGroup>
      </div>
      {/* A plugin frame treats a hidden tab as closed (its effects end), so it only lives in the visible one. */}
      {visible ? <PluginSlot slot="artifact.sidePanel" context={{ artifact }} /> : null}
    </div>
  );
}

/** Text selected in the doc frame, as its selection bridge reports it; `dismiss` hides the button until the next selection. */
function useDocSelection(frame: RefObject<HTMLIFrameElement | null>) {
  const [current, setCurrent] = useState<{ text: string; rect: SelectionRect } | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this tab's own frame: other docs and plugins post messages too.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = readSelectionMessage(e.data);
      if (m) setCurrent(m.text && m.rect ? { text: m.text, rect: m.rect } : null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);
  return { current, dismiss: () => setCurrent(null) };
}

/**
 * The content channel of this tab's doc frame: storage for the content scripts of the plugins
 * that are on, scoped to this document, the selection actions they declared, in plugin id order,
 * and the anchors a plugin's `open` queued for this tab. What the scripts said lives in a session
 * per frame URL, so a reloaded frame starts clean while a tab back from the background (its
 * effects ended, its frame kept running) keeps them.
 */
function useContentChannel(
  frame: RefObject<HTMLIFrameElement | null>,
  src: string | undefined,
  fileKey: string | undefined,
  list: HostPlugin[],
  client: ContentChannelDeps["client"],
) {
  const ids = contentPlugins(list).map((p) => p.id).join(",");
  const viewer = useViewerStore();
  const tabId = useCurrentTabId();
  const session = useMemo(() => (src ? newFrameSession() : null), [src]);
  const channel = useRef<ContentChannel | null>(null);
  const [declared, setDeclared] = useState<ReadonlyMap<string, ContentAction[]>>(new Map());
  useEffect(() => {
    if (!fileKey || !session) return;
    const ch = ids
      ? createContentChannel({
          fileKey,
          plugins: new Set(ids.split(",")),
          frame: () => frame.current?.contentWindow ?? null,
          session,
          client,
          onActions: setDeclared,
        })
      : null;
    channel.current = ch;
    setDeclared(new Map(session.actions));
    // An anchor for a plugin with no content script here has nowhere to go, so it is dropped too.
    const deliver = () => {
      const r = viewer.takeReveal(tabId);
      if (r) ch?.reveal(r.pluginId, r.anchor);
    };
    deliver();
    const stopReveals = viewer.subscribe(deliver);
    const onMessage = (e: MessageEvent) => ch?.receive(e);
    window.addEventListener("message", onMessage);
    return () => {
      stopReveals();
      window.removeEventListener("message", onMessage);
      ch?.dispose();
      channel.current = null;
    };
  }, [frame, fileKey, ids, session, client, viewer, tabId]);
  const actions = useMemo(
    () => [...declared].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([plugin, items]) => items.map((it) => ({ plugin, ...it }))),
    [declared],
  );
  return { actions, run: (plugin: string, actionId: string) => channel.current?.runAction(plugin, actionId) };
}
