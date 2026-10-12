import { useEffect, useState } from "react";
import type { Artifact, Session } from "@alto-rooms/protocol-ts";
import { AgentMark } from "@/components/AgentMark";
import { AGENT_NAMES } from "@/lib/agents";
import { useClient, useViewerStore } from "@/data/hooks";
import { sameSession, sessionKey, sessionTab, sessionTitle, sourceSessionRef } from "@/lib/sessions";
import { localDate } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";

/**
 * The session that wrote the artifact, when the artifact names its session (`rooms:agent` and
 * `rooms:session`) and the Journal has that session on the day the artifact was created or last
 * changed; null otherwise.
 */
function useWritingSession(artifact: Artifact): Session | null {
  const client = useClient();
  const writer = sourceSessionRef(artifact.source);
  const key = writer ? sessionKey(writer) : null;
  const days = [...new Set([artifact.createdAt, artifact.updatedAt].map((t) => localDate(new Date(t))))].join(",");
  const [found, setFound] = useState<{ key: string; session: Session | null } | null>(null);
  const { agent, id } = writer ?? {};
  useEffect(() => {
    if (!agent || !id) return;
    const sessionRef = { agent, id };
    let live = true;
    void Promise.all(days.split(",").map((d) => client.journalDay(d).then(({ data }) => data.sessions, () => []))).then((lists) => {
      const session = lists.flat().find((j) => sameSession(j.session, sessionRef))?.session ?? null;
      if (live) setFound({ key: sessionKey(sessionRef), session });
    });
    return () => {
      live = false;
    };
  }, [client, agent, id, days]);
  return found?.key === key ? found.session : null;
}

/** A quiet "Written in <title>" in the artifact's toolbar that opens the session's tab (⌘-click or a middle click in a new one). */
export function WrittenIn({ artifact }: { artifact: Artifact }) {
  const session = useWritingSession(artifact);
  const viewer = useViewerStore();
  if (!session) return null;
  const open = (newTab: boolean) => viewer.go(sessionTab(session), newTab);
  return (
    <button
      type="button"
      onClick={(e) => open(wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && open(true)}
      className="inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg pr-2.5 pl-2 text-small whitespace-nowrap text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline)] outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
    >
      <AgentMark agent={session.agent} className="text-ink-2" />
      Written in{" "}
      <span className="max-w-[240px] min-w-0 truncate font-medium text-ink">{sessionTitle(session)}</span>
      <span className="sr-only">, a {AGENT_NAMES[session.agent]} session</span>
    </button>
  );
}
