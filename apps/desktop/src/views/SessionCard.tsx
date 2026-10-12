import type { Session } from "@alto-rooms/protocol-ts";
import { AgentMark } from "@/components/AgentMark";
import { Dotted } from "@/components/Dotted";
import { useViewerStore } from "@/data/hooks";
import { AGENT_NAMES } from "@/lib/agents";
import { sessionTab, sessionTitle } from "@/lib/sessions";
import { count, shortAge } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";
import { SessionMenu } from "./SessionMenu";

/**
 * A session in a room: three quiet lines (title, the agent's last reply, agent · messages ·
 * time) in a hairline outline, quieter than an artifact card. A click opens it in a tab like an
 * artifact; right-click opens the room menu.
 */
export function SessionCard({ session }: { session: Session }) {
  const viewer = useViewerStore();
  const title = sessionTitle(session);
  const written = session.artifactsWritten.length;
  const open = (newTab: boolean) => viewer.go(sessionTab(session), newTab);
  return (
    <SessionMenu session={session}>
      <article
        data-testid="session-card"
        role="button"
        aria-label={title}
        tabIndex={0}
        onClick={(e) => open(wantsNewTab(e))}
        onAuxClick={(e) => e.button === 1 && open(true)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          open(wantsNewTab(e));
        }}
        className="cursor-pointer min-w-0 rounded-xl py-3 pr-3.5 pl-4 shadow-[inset_0_0_0_1px_var(--hairline-strong)] outline-none transition-[background-color,box-shadow] duration-150 hover:bg-sheet hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink data-[state=open]:bg-sheet data-[state=open]:shadow-lift"
      >
        <h3 className="truncate text-body font-semibold text-ink">{title}</h3>
        <p className="mt-0.5 truncate text-small leading-[18px] text-ink-2">{session.lastReply ?? " "}</p>
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-small whitespace-nowrap text-ink-3">
          <AgentMark agent={session.agent} className="size-[13px] text-ink-3" />
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <Dotted parts={[AGENT_NAMES[session.agent], count(session.messages, "msg"), shortAge(session.endedAt), written ? count(written, "artifact") : null]} />
          </span>
        </div>
      </article>
    </SessionMenu>
  );
}
