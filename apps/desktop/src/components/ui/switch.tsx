import type * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/** An on/off switch, macOS-sized (32 × 18), on in ink so red stays rare. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 items-center rounded-pill bg-hairline-strong p-0.5 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50 data-[state=checked]:bg-ink",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[14px] rounded-full bg-sheet shadow-sheet transition-transform data-[state=checked]:translate-x-[14px] motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
