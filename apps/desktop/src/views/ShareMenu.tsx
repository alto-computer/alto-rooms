import type { Artifact, Info, Room } from "@alto-rooms/protocol-ts";
import { AppWindow, Copy, FolderSearch, Share } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { IconTip } from "@/components/IconTip";
import { toolbarButton } from "@/components/ToolbarGroup";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useInfo, useRoomList } from "@/data/hooks";
import { copyText } from "@/lib/clipboard";
import { docOriginal, openDoc, revealDoc } from "@/lib/native";
import { isTauri } from "@/lib/tauri";

/** One toast slot, so repeated picks replace it instead of stacking. */
const TOAST_ID = "doc-share";

/** Where the doc sits in its room: a link to the original for an agent-written doc. */
function roomLinkPath(info: Info, rooms: Room[], artifact: Artifact): string | null {
  const root = artifact.roomId === info.journalRoomId ? `${info.home}/journal` : rooms.find((r) => r.id === artifact.roomId)?.path;
  return root ? `${root}/${artifact.relPath}` : null;
}

/** How far the group's right edge sits past the trigger's, so the menu can line up with the group. */
const groupEndGap = (trigger: HTMLElement) => trigger.parentElement!.getBoundingClientRect().right - trigger.getBoundingClientRect().right;

/**
 * The doc tab's Share menu, all local: copy the original file's path, reveal it
 * in Finder, or open it in the default browser. The last two need the app.
 */
export function ShareMenu({ artifact }: { artifact: Artifact }) {
  const info = useInfo();
  const rooms = useRoomList();
  const trigger = useRef<HTMLButtonElement>(null);
  const [toGroupEnd, setToGroupEnd] = useState(0);
  const link = info ? roomLinkPath(info, rooms, artifact) : null;
  if (!link) return null;

  const run = (failure: string, action: () => Promise<void>) => {
    action().catch((err: unknown) => {
      console.warn(`share: ${failure}`, err);
      toast.error(failure, { id: TOAST_ID });
    });
  };
  const copyPath = () =>
    run("Couldn't copy the path", async () => {
      await copyText(docOriginal(link));
      toast("Copied file path", { id: TOAST_ID });
    });

  return (
    <DropdownMenu onOpenChange={(open) => open && setToGroupEnd(groupEndGap(trigger.current!))}>
      <IconTip label="Share">
        <DropdownMenuTrigger ref={trigger} aria-label="Share" className={toolbarButton}>
          <Share size={15} aria-hidden />
        </DropdownMenuTrigger>
      </IconTip>
      <DropdownMenuContent align="end" alignOffset={-toGroupEnd} sideOffset={6} className="w-auto min-w-44 text-body">
        <DropdownMenuItem onSelect={copyPath}>
          <Copy aria-hidden />
          Copy file path
        </DropdownMenuItem>
        {isTauri() ? (
          <>
            <DropdownMenuItem onSelect={() => run("Couldn't reveal the file", () => revealDoc(link))}>
              <FolderSearch aria-hidden />
              Reveal in Finder
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run("Couldn't open the file", () => openDoc(link))}>
              <AppWindow aria-hidden />
              Open in browser
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
