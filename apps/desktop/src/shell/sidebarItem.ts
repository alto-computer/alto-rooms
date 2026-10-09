/** Shared sizing for sidebar rows: 28px tall, 13px label, 16px icon, radius 8. */
export const ITEM = "flex h-7 w-full min-w-0 items-center gap-[9px] rounded-lg px-2 text-left text-body text-ink";
export const ITEM_INTERACTIVE = "hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink";
/** The row for the page being viewed: a quiet capsule. */
export const ITEM_CURRENT = "bg-surface-strong font-medium hover:bg-surface-strong";
/** A section label ("Rooms", "Plugins"). */
export const SECTION = "flex h-7 items-center justify-between pr-1 pl-2 text-caption font-semibold tracking-[.02em] text-ink-3";
export const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
