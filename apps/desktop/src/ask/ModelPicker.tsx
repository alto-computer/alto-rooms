import { ChevronDown, Lock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AskTarget } from "@alto-rooms/protocol-ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { modelLabel } from "./askModel";

const CHIP = "rounded-full bg-surface px-2 py-0.5 text-small whitespace-nowrap text-ink-2";

/** A plain agent name: no models to pick, or roomsd hasn't said yet. */
export function AgentChip({ name }: { name: string }) {
  return <span className={CHIP}>{name}</span>;
}

/** A lock beside the agent chip when the agent can't read past the listed files; the words show on hover or keyboard focus. */
export function ReadScopeHint({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 focus-visible:outline-2 focus-visible:outline-ink"
          >
            <Lock className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The agent an ask goes to; a menu of its models when it has any. "" in the menu is the agent's default. */
export function ModelPicker({ target, model, onChange }: { target: AskTarget; model: string | null; onChange: (m: string | null) => void }) {
  if (target.models.length === 0) return <AgentChip name={target.agent} />;
  const label = `${target.agent} · ${modelLabel(model)}`;
  return (
    <DropdownMenu>
      {/* The trigger is a 28px hit area; the chip inside keeps its small look. */}
      <DropdownMenuTrigger aria-label={`Model: ${label}`} className="group flex min-h-7 shrink-0 items-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-ink">
        <span className={`${CHIP} flex items-center gap-1 group-hover:bg-surface-strong group-data-[state=open]:bg-surface-strong`}>
          {label}
          <ChevronDown className="size-3" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-auto min-w-36">
        <DropdownMenuRadioGroup value={model ?? ""} onValueChange={(v) => onChange(v || null)}>
          {["", ...target.models].map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="text-small">
              {modelLabel(m || null)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
