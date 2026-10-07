import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useCopy } from "@/views/CopyChip";

/** One toast slot for copy failures, so repeated clicks replace it instead of stacking. */
const TOAST_ID = "ask-copy";

/** Icon button that copies an answer: a check while "copied", and a toast only if it fails. */
export function CopyAnswerButton({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  const onClick = async () => {
    if (!(await copy(text))) toast.error("Couldn't copy", { id: TOAST_ID });
  };
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label="Copy answer"
      data-copied={copied ? "true" : undefined}
      className="text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      onClick={() => void onClick()}
    >
      <Icon size={14} />
    </button>
  );
}
