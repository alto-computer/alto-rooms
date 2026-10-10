import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Artifact, Info, Room } from "@alto-rooms/protocol-ts";
import { BookOpen, ChevronRight, Folder, Inbox } from "lucide-react";
import { useArtifacts, useAsksStore, useClient, useInfo, usePlugins, useReadOnly, useRoomList, useScopeError, useViewerStore } from "@/data/hooks";
import { dimsInDark, useFrameTone } from "@/lib/artifactTone";
import { INBOX_ID } from "@/lib/drag";
import { GENERIC_ERROR } from "@/lib/errors";
import { wantsNewTab } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { PluginSlot, SidePanelOpener } from "@/plugins/PluginSlot";
import { createContentChannel, type ContentAction, type ContentChannel, type ContentChannelDeps } from "@/plugins/contentChannel";
import { contentKey, contentPlugins, type HostPlugin } from "@/plugins/pluginsStore";
import { RoomDot } from "@/components/RoomDot";
import { ToolbarGroup } from "@/components/ToolbarGroup";
import { useCurrentTabId, useTabVisible } from "@/shell/currentTab";
import { AskBar } from "@/ask/AskBar";
import { askAction, SelectionBar, type SelectionAction } from "@/selection/SelectionBar";
import { readSelectionMessage, type SelectionRect } from "@/selection/useTextSelection";
import { DocSkeleton } from "./DocSkeleton";
import { ShareMenu } from "./ShareMenu";
import { WrittenIn } from "./WrittenIn";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center bg-pane p-12 text-center text-heading text-ink-2">{children}</div>;
}

/** Where the artifact lives › its title. The room opens on click (the Journal's day has no room tab). */
function Breadcrumb({ artifact, room, info }: { artifact: Artifact; room: Room | undefined; info: Info }) {
  const viewer = useViewerStore();
  const journal = artifact.roomId === info.journalRoomId;
  const inbox = artifact.roomId === INBOX_ID;
  const Mark = journal ? BookOpen : inbox ? Inbox : Folder;
  const name = journal ? "Journal" : inbox ? "Inbox" : (room?.name ?? "Room");
  const place = (
    <>
      {room?.color ? <RoomDot color={room.color} className="size-3.5" /> : <Mark size={14} className="shrink-0 text-ink-3" aria-hidden />}
      <span className="truncate">{name}</span>
    </>
  );
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-[7px] text-body whitespace-nowrap text-ink-2">
      {journal ? (
        <span className="flex min-w-0 items-center gap-[7px]">{place}</span>
      ) : (
        <button
          type="button"
          onClick={(e) => viewer.go({ kind: "room", roomId: artifact.roomId }, wantsNewTab(e))}
          onAuxClick={(e) => e.button === 1 && viewer.go({ kind: "room", roomId: artifact.roomId }, true)}
          className="-mx-1.5 flex min-w-0 items-center gap-[7px] rounded-md px-1.5 py-0.5 outline-none hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          {place}
        </button>
      )}
      <ChevronRight size={12} className="shrink-0 text-ink-3" aria-hidden />
      <span aria-current="page" className="truncate font-semibold text-ink">
        {artifact.title}
      </span>
    </nav>
  );
}

/**
 * A doc tab: a toolbar (breadcrumb, Share, the plugin opener) over one artifact on a sheet, in a
 * sandboxed iframe from the files origin. In dark mode the page is dimmed unless it reported a
 * dark background itself. The ask bar and its answers float over the page. Watches the artifact's
 * room so a removal shows the "gone" copy.
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
  const tone = useFrameTone(frame);
  const asks = useAsksStore();
  const readOnly = useReadOnly();
  const plugins = usePlugins();
  const artifact = artifacts?.find((a) => a.id === artifactId);
  const src = info && artifact ? client.fileUrl(info, artifact, { contentKey: contentKey(plugins.list) }) : undefined;
  const content = useContentChannel(frame, artifact, plugins.list, client);

  // The store forgets a removed room's artifacts; its documents are gone too.
  const roomGone = info !== null && roomId !== info.journalRoomId && !rooms.some((r) => r.id === roomId);
  if (roomGone) return <Centered>This artifact is gone</Centered>;
  if (artifacts === undefined) {
    return loadError ? <Centered>{GENERIC_ERROR}</Centered> : <div className="flex-1 bg-pane" />;
  }
  if (!artifact) return <Centered>This artifact is gone</Centered>;
  if (!info) return <div className="flex-1 bg-pane" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pane">
      <header className="flex h-[52px] shrink-0 items-center gap-3 pr-4 pl-5">
        <Breadcrumb artifact={artifact} room={rooms.find((r) => r.id === roomId)} info={info} />
        <WrittenIn artifact={artifact} />
        <ToolbarGroup label="Artifact actions">
          <ShareMenu artifact={artifact} />
          {visible ? <SidePanelOpener /> : null}
        </ToolbarGroup>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 px-4 pb-4">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl bg-white shadow-sheet">
            {/* No allow-same-origin: a doc is agent-written HTML and must never reach the app. What
                it shares comes out by postMessage only: the selection and tone bridge roomsd splices in, and
                the content scripts of the plugins the user turned on, which the doc variant adds. */}
            <iframe
              title={artifact.title}
              ref={frame}
              src={src}
              sandbox="allow-scripts allow-popups"
              onLoad={(e) => {
                setLoaded(true);
                content.frameLoaded(e.currentTarget.src);
              }}
              className={cn(
                "absolute inset-0 size-full border-0 bg-white transition-opacity duration-300 ease-out motion-reduce:transition-none",
                loaded ? "opacity-100" : "opacity-0",
                dimsInDark(tone) && "[filter:var(--artifact-filter)]",
              )}
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
          </div>
          <AskBar subject={{ kind: "doc", artifact }} />
        </div>
        {/* A plugin frame treats a hidden tab as closed (its effects end), so it only lives in the visible one. */}
        {visible ? <PluginSlot slot="artifact.sidePanel" context={{ artifact }} /> : null}
      </div>
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
 * and the anchors a plugin's `open` queued for this tab. A new channel per frame load and each
 * time the tab comes back from the background; the frame tells each one what its scripts said.
 * Call `frameLoaded` with the frame's URL from its load event, which also fires in the background.
 */
function useContentChannel(
  frame: RefObject<HTMLIFrameElement | null>,
  artifact: Artifact | undefined,
  list: HostPlugin[],
  client: ContentChannelDeps["client"],
) {
  const ids = contentPlugins(list).map((p) => p.id).join(",");
  const key = contentKey(list);
  const viewer = useViewerStore();
  const tabId = useCurrentTabId();
  const channel = useRef<ContentChannel | null>(null);
  // The URL the frame last finished loading. A channel made while the frame loads a new URL asks on
  // that load instead, so the page on its way out cannot answer for the one coming in.
  const loadedUrl = useRef<string | null>(null);
  const [declared, setDeclared] = useState<ReadonlyMap<string, ContentAction[]>>(new Map());
  const fileKey = artifact?.fileKey;
  // With `key` it names the frame's URL: a change means the frame loads again.
  const version = artifact?.updatedAt;
  useEffect(() => {
    setDeclared(new Map());
    if (!fileKey) return;
    const ch = ids
      ? createContentChannel({
          fileKey,
          plugins: new Set(ids.split(",")),
          frame: () => frame.current?.contentWindow ?? null,
          client,
          onActions: setDeclared,
          onReady: () => deliver(),
        })
      : null;
    // Without a channel no script in this frame could ever take it, so it is dropped.
    const deliver = () => viewer.takeReveal(tabId, (r) => !ch || ch.reveal(r.pluginId, r.anchor));
    channel.current = ch;
    if (ch && frame.current?.src === loadedUrl.current) ch.sync();
    deliver();
    const stopReveals = viewer.subscribe(deliver);
    if (!ch) return stopReveals;
    const onMessage = (e: MessageEvent) => ch.receive(e);
    window.addEventListener("message", onMessage);
    return () => {
      stopReveals();
      window.removeEventListener("message", onMessage);
      ch.dispose();
      channel.current = null;
    };
  }, [frame, fileKey, version, key, ids, client, viewer, tabId]);
  const actions = useMemo(
    () => [...declared].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([plugin, items]) => items.map((it) => ({ plugin, ...it }))),
    [declared],
  );
  return {
    actions,
    run: (plugin: string, actionId: string) => channel.current?.runAction(plugin, actionId),
    // Not from `frame`: React detaches the ref while the tab is in the background.
    frameLoaded: (url: string) => {
      loadedUrl.current = url;
      channel.current?.sync();
    },
  };
}
