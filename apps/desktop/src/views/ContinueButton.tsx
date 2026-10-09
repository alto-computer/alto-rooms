import type { Conversation } from "@alto-rooms/protocol-ts";
import { toast } from "sonner";
import { AgentMark } from "@/components/AgentMark";
import { AGENT_NAMES } from "@/lib/agents";
import { continueConversation } from "@/lib/native";
import { cn } from "@/lib/utils";

const TOAST_ID = "continue-conversation";

/** Resumes the conversation in Terminal; says so when it can't (the web build has no Terminal). */
export function continueIn(conversation: Conversation): void {
  continueConversation(conversation).then(
    (opened) => {
      if (!opened) toast("Continuing a conversation needs the Rooms app", { id: TOAST_ID });
    },
    (e: unknown) => {
      console.warn("could not continue the conversation", e);
      toast.error("Couldn't open Terminal", { id: TOAST_ID });
    },
  );
}

/** The one continue action: an ink pill, "Continue in <Agent>", that resumes the real session in Terminal. */
export function ContinueButton({ conversation, className }: { conversation: Conversation; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        continueIn(conversation);
      }}
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
