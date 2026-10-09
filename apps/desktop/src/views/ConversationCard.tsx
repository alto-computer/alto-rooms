import type { Conversation } from "@alto-rooms/protocol-ts";
import { AgentMark } from "@/components/AgentMark";
import { Dotted } from "@/components/Dotted";
import { AGENT_NAMES } from "@/lib/agents";
import { conversationTitle } from "@/lib/conversations";
import { count, shortAge } from "@/lib/dates";
import { ContinueButton } from "./ContinueButton";
import { ConversationMenu } from "./ConversationMenu";

/**
 * A conversation in a room: three quiet lines (title, the agent's last reply, agent · messages ·
 * time) in a hairline outline, quieter than an artifact card. Hover shows the continue pill;
 * right-click opens the menu.
 */
export function ConversationCard({ conversation }: { conversation: Conversation }) {
  const title = conversationTitle(conversation);
  const written = conversation.artifactsWritten.length;
  return (
    <ConversationMenu conversation={conversation}>
      <article
        data-testid="conversation-card"
        aria-label={title}
        tabIndex={0}
        className="group min-w-0 rounded-xl py-3 pr-3.5 pl-4 shadow-[inset_0_0_0_1px_var(--hairline-strong)] outline-none transition-[background-color,box-shadow] duration-150 hover:bg-sheet hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink data-[state=open]:bg-sheet data-[state=open]:shadow-lift"
      >
        <h3 className="truncate text-body font-semibold text-ink">{title}</h3>
        <p className="mt-0.5 truncate text-small leading-[18px] text-ink-2">{conversation.lastReply ?? " "}</p>
        <div className="mt-1.5 flex h-7 min-w-0 items-center gap-1.5 text-small whitespace-nowrap text-ink-3">
          <AgentMark agent={conversation.id.agent} className="size-[13px] text-ink-3" />
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <Dotted parts={[AGENT_NAMES[conversation.id.agent], count(conversation.messages, "msg"), shortAge(conversation.endedAt), written ? count(written, "artifact") : null]} />
          </span>
          <ContinueButton
            conversation={conversation}
            className="ml-auto opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 group-data-[state=open]:opacity-100"
          />
        </div>
      </article>
    </ConversationMenu>
  );
}
