import { Check, ChevronDown } from "lucide-react";
import type { AskTarget } from "@alto-rooms/protocol-ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { modelLabel } from "./askModel";

const CHIP = "rounded-full bg-[#f2f2f2] px-2 py-0.5 text-[11.5px] whitespace-nowrap text-ink-2";

/** The agent an ask goes to; a menu of its models when it has any. */
export function ModelPicker({ target, model, onChange }: { target: AskTarget; model: string | null; onChange: (m: string | null) => void }) {
  if (target.models.length === 0) return <span className={CHIP}>{target.agent}</span>;
  const choices: (string | null)[] = [null, ...target.models];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Model" className={`${CHIP} flex items-center gap-1 outline-none hover:bg-[#e9e9e9] focus-visible:ring-2 focus-visible:ring-primary/30`}>
        {target.agent} · {modelLabel(model)}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-auto min-w-36">
        {choices.map((m) => (
          <DropdownMenuItem key={m ?? ""} onSelect={() => onChange(m)} className="text-[12.5px]">
            <span className="flex-1">{modelLabel(m)}</span>
            {m === model ? <Check aria-label="Current" className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
