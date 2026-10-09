import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A page-shaped placeholder (a title and a few lines of text) shown while an
 * artifact's iframe loads, so the page never flashes plain white. `compact`
 * scales it down for small previews.
 */
export function DocSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div data-testid="doc-skeleton" aria-hidden className={cn("absolute inset-0 flex flex-col bg-sheet", compact ? "gap-2 p-3" : "gap-3 p-8")}>
      <Skeleton className={cn(compact ? "h-3 w-1/2" : "h-6 w-2/5")} />
      <Skeleton className={cn(compact ? "mt-1 h-2 w-11/12" : "mt-3 h-3 w-full max-w-[720px]")} />
      <Skeleton className={cn(compact ? "h-2 w-4/5" : "h-3 w-11/12 max-w-[660px]")} />
      <Skeleton className={cn(compact ? "h-2 w-3/5" : "h-3 w-3/5 max-w-[440px]")} />
    </div>
  );
}
