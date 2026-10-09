import type { Conversation } from "@alto-rooms/protocol-ts";
import { toast } from "sonner";
import { AgentMark } from "@/components/AgentMark";
import { AGENT_NAMES } from "@/lib/agents";
import { continueConversation } from "@/lib/native";
import { cn } from "@/lib/utils";

const TOAST_ID = "continue-conversation";

/**
 * "Continue in <Agent>": an ink pill in a session tab's toolbar that resumes the real session in
 * Terminal, and says so when it can't (the web build has no Terminal).
 */
export function ContinueButton({ conversation, className }: { conversation: Conversation; className?: string }) {
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
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-[5px] rounded-[7px] bg-ink pr-[9px] pl-2 text-small font-medium whitespace-nowrap text-pane shadow-[0_1px_2px_rgb(40_20_10/.18)] outline-none hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        className,
      )}
    >
      <AgentMark agent={conversation.id.agent} className="size-[13px]" />
      Continue in {AGENT_NAMES[conversation.id.agent]}
    </button>
  );
}
