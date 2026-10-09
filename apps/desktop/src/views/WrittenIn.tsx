import { useEffect, useState } from "react";
import type { Artifact, Conversation } from "@alto-rooms/protocol-ts";
import { ChevronDown } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Dotted } from "@/components/Dotted";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useClient, useInfo, useViewerStore } from "@/data/hooks";
import { AGENT_NAMES, isAgent } from "@/lib/agents";
import { conversationKey, conversationTab, conversationTitle, sameConversation } from "@/lib/conversations";
import { count, localDate, shortAge } from "@/lib/dates";
import { wantsNewTab } from "@/lib/nav";
import { tildePath } from "@/lib/paths";
import { ContinueButton } from "./ContinueButton";

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

/** A quiet "Written in <title>" in the artifact's toolbar; it opens a small card with the continue pill, whose title opens the session's tab. */
export function WrittenIn({ artifact }: { artifact: Artifact }) {
  const conversation = useWritingConversation(artifact);
  const home = useInfo()?.home;
  const viewer = useViewerStore();
  if (!conversation) return null;
  const title = conversationTitle(conversation);
  const agent = AGENT_NAMES[conversation.id.agent];
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg pr-2.5 pl-2 text-small whitespace-nowrap text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline)] outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink data-[state=open]:bg-surface">
        <AgentMark agent={conversation.id.agent} className="text-ink-2" />
        Written in
        <span className="max-w-[240px] min-w-0 truncate font-medium text-ink">{title}</span>
        <ChevronDown size={12} aria-hidden className="shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} aria-label="Written in" className="w-[320px] px-4 py-3.5">
        <h4 className="line-clamp-2 text-body font-semibold text-ink">
          <button
            type="button"
            onClick={(e) => viewer.go(conversationTab(conversation.id), wantsNewTab(e))}
            onAuxClick={(e) => e.button === 1 && viewer.go(conversationTab(conversation.id), true)}
            className="rounded-sm text-left outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ink"
          >
            {title}
          </button>
        </h4>
        {conversation.lastReply ? <p className="mt-0.5 truncate text-small leading-[18px] text-ink-2">{conversation.lastReply}</p> : null}
        <p className="mt-1.5 flex items-center gap-1.5 text-small whitespace-nowrap text-ink-3">
          <AgentMark agent={conversation.id.agent} className="size-[13px]" />
          <Dotted parts={[agent, count(conversation.messages, "msg"), shortAge(conversation.endedAt)]} />
        </p>
        <ContinueButton conversation={conversation} className="mt-3.5 h-7 px-2.5" />
        {conversation.cwd ? (
          <p className="mt-2 text-caption text-ink-3">
            Resumes in Terminal, in <span className="font-mono text-ink-2">{home ? tildePath(conversation.cwd, home) : conversation.cwd}</span>
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
