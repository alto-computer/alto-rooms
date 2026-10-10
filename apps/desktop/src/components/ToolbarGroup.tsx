import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

export const toolbarButton =
  "flex h-full w-9 items-center justify-center text-ink outline-none hover:bg-ink/5 focus-visible:bg-ink/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink data-[state=open]:bg-ink/5";

/** Icon buttons in a document's toolbar, in one bordered group split by hairlines, at the toolbar's end; hidden when none render. */
export function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <div
        role="group"
        aria-label={label}
        className="ml-auto flex h-8 shrink-0 overflow-hidden rounded-lg border border-hairline bg-sheet shadow-sheet empty:hidden [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-y-1.5 [&>*+*]:before:left-0 [&>*+*]:before:w-px [&>*+*]:before:bg-hairline"
      >
        {children}
      </div>
    </TooltipProvider>
  );
}
