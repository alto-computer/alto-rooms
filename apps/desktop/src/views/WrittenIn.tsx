import { useEffect, useState } from "react";
import type { Artifact, Conversation } from "@alto-rooms/protocol-ts";
import { AgentMark } from "@/components/AgentMark";
import { useClient, useViewerStore } from "@/data/hooks";
import { isAgent } from "@/lib/agents";
import { conversationKey, conversationTab, conversationTitle, sameConversation } from "@/lib/conversations";
import { localDate } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";

/**
 * The conversation that wrote the artifact, when the artifact names its session (`rooms:agent` and
 * `rooms:session`) and the Journal has that conversation on the day the artifact was created or
 * last changed; null otherwise.
 */
function useWritingConversation(artifact: Artifact): Conversation | null {
  const client = useClient();
  const { agent, session } = artifact.source;
  const key = isAgent(agent) && session ? conversationKey({ agent, session }) : null;
  const days = [...new Set([artifact.createdAt, artifact.updatedAt].map((t) => localDate(new Date(t))))].join(",");
  const [found, setFound] = useState<{ key: string; conversation: Conversation | null } | null>(null);
  useEffect(() => {
    if (!isAgent(agent) || !session) return;
    const id = { agent, session };
    let live = true;
    void Promise.all(days.split(",").map((d) => client.journalDay(d).then(({ data }) => data.conversations, () => []))).then((lists) => {
      const conversation = lists.flat().find((j) => sameConversation(j.conversation.id, id))?.conversation ?? null;
      if (live) setFound({ key: conversationKey(id), conversation });
    });
    return () => {
      live = false;
    };
  }, [client, agent, session, days]);
  return found?.key === key ? found.conversation : null;
}

/** A quiet "Written in <title>" in the artifact's toolbar that opens the session's tab (⌘-click or a middle click in a new one). */
export function WrittenIn({ artifact }: { artifact: Artifact }) {
  const conversation = useWritingConversation(artifact);
  const viewer = useViewerStore();
  if (!conversation) return null;
  const open = (newTab: boolean) => viewer.go(conversationTab(conversation.id), newTab);
  return (
    <button
      type="button"
      onClick={(e) => open(wantsNewTab(e))}
      onAuxClick={(e) => e.button === 1 && open(true)}
      className="inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg pr-2.5 pl-2 text-small whitespace-nowrap text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline)] outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
    >
      <AgentMark agent={conversation.id.agent} className="text-ink-2" />
      Written in{" "}
      <span className="max-w-[240px] min-w-0 truncate font-medium text-ink">{conversationTitle(conversation)}</span>
    </button>
  );
}
