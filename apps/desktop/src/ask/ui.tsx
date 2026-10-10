import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

/** Error copy in the app's muted red, with an icon so it reads as an error at a glance. */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-small text-error">
      <CircleAlert size={14} aria-hidden className="mt-[2px] shrink-0" />
      <span className="whitespace-pre-wrap">{children}</span>
    </p>
  );
}

/** A small text button with a full 28px hit area, pulled left so its label lines up with the text above. */
export function TextButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 inline-flex min-h-7 items-center rounded-md px-2 text-small font-medium text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
    >
      {children}
    </button>
  );
}

/** A square icon button for a row of small actions (a queued question, a quote chip). */
export const ICON_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-ink";
