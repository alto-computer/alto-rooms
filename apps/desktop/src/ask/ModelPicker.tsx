import { ChevronDown } from "lucide-react";
import type { AskTarget } from "@alto-rooms/protocol-ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { modelLabel } from "./askModel";

const CHIP = "rounded-full bg-[#f2f2f2] px-2 py-0.5 text-[11.5px] whitespace-nowrap text-ink-2";

/** A plain agent name: no models to pick, or roomsd hasn't said yet. */
export function AgentChip({ name }: { name: string }) {
  return <span className={CHIP}>{name}</span>;
}

/** The agent an ask goes to; a menu of its models when it has any. "" in the menu is the agent's default. */
export function ModelPicker({ target, model, onChange }: { target: AskTarget; model: string | null; onChange: (m: string | null) => void }) {
  if (target.models.length === 0) return <AgentChip name={target.agent} />;
  const label = `${target.agent} · ${modelLabel(model)}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`Model: ${label}`} className={`${CHIP} flex items-center gap-1 outline-none hover:bg-[#e9e9e9] focus-visible:ring-2 focus-visible:ring-primary/30`}>
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-auto min-w-36">
        <DropdownMenuRadioGroup value={model ?? ""} onValueChange={(v) => onChange(v || null)}>
          {["", ...target.models].map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="text-[12.5px]">
              {modelLabel(m || null)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
