import sleep from "@/assets/clew-sleep.svg?raw";
import { cn } from "@/lib/utils";

/**
 * Clew asleep, drawn inline so the SVG's `var(--ink)` and `var(--thread)` follow the theme. He
 * breathes slowly (over five seconds); under reduced motion he lies still.
 */
export function ClewSleep({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("block origin-bottom motion-safe:animate-breathe [&>svg]:block [&>svg]:h-auto [&>svg]:w-full", className)}
      // Our own asset, bundled at build time.
      dangerouslySetInnerHTML={{ __html: sleep }}
    />
  );
}
