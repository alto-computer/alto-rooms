import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

export const toolbarButton =
  "flex h-full w-9 items-center justify-center text-ink outline-none hover:bg-ink/5 focus-visible:bg-ink/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink data-[state=open]:bg-ink/5";

/** Icon buttons floating over a document, in one bordered group split by hairlines; hidden when none render. */
export function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <div
        role="group"
        aria-label={label}
        className="absolute top-3 right-3 z-10 flex h-8 overflow-hidden rounded-lg border border-hairline bg-sheet/90 shadow-sheet backdrop-blur-md empty:hidden [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-y-1.5 [&>*+*]:before:left-0 [&>*+*]:before:w-px [&>*+*]:before:bg-hairline"
      >
        {children}
      </div>
    </TooltipProvider>
  );
}
