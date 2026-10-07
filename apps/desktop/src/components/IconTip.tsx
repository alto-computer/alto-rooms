import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A short hover hint for an icon-only button (its name, then its shortcut, dimmed), shown after a beat. */
export function IconTip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactElement }) {
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
        {shortcut ? <span className="opacity-60">{shortcut}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
