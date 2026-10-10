import peek from "@/assets/clew-peek.svg?raw";
import { cn } from "@/lib/utils";

/** Clew peeking out of the water, drawn inline so the SVG's `var(--ink)` and `var(--thread)` follow the theme. */
export function ClewPeek({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("block [&>svg]:block [&>svg]:h-auto [&>svg]:w-full", className)}
      // Our own asset, bundled at build time.
      dangerouslySetInnerHTML={{ __html: peek }}
    />
  );
}
