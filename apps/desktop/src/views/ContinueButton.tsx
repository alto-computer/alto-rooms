import type { Conversation } from "@alto-rooms/protocol-ts";
import { toast } from "sonner";
import { AgentMark } from "@/components/AgentMark";
import { AGENT_NAMES } from "@/lib/agents";
import { continueConversation } from "@/lib/native";

const TOAST_ID = "continue-conversation";

/**
 * "Continue in <Agent>": an ink button in a session tab's toolbar that resumes the real session in
 * Terminal, and says so when it can't (the web build has no Terminal).
 */
export function ContinueButton({ conversation }: { conversation: Conversation }) {
  const onClick = () => {
    continueConversation(conversation).then(
      (opened) => {
        if (!opened) toast("Continuing a session needs the Rooms app", { id: TOAST_ID });
      },
      (e: unknown) => {
        console.warn("could not continue the conversation", e);
        toast.error("Couldn't open Terminal", { id: TOAST_ID });
      },
    );
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 shrink-0 items-center gap-[5px] rounded-lg bg-ink px-2.5 text-body font-medium whitespace-nowrap text-pane shadow-sheet outline-none hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <AgentMark agent={conversation.id.agent} className="size-[13px]" />
      Continue in {AGENT_NAMES[conversation.id.agent]}
    </button>
  );
}
