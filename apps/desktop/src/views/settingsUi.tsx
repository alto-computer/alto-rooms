/*
 * The Settings tab's building blocks: a titled section holding one grouped
 * card of rows (label on the left, its control on the right), as in macOS
 * System Settings.
 */
import type { ReactNode } from "react";
import { settingsSectionId, type SettingsSection } from "@/lib/settings";
import { cn } from "@/lib/utils";

export function Section({ section, title, footnote, children }: { section: SettingsSection; title: string; footnote?: ReactNode; children: ReactNode }) {
  const id = settingsSectionId(section);
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-8 flex-col">
      <h2 id={`${id}-title`} className="mb-2 px-1 text-body font-semibold text-ink">
        {title}
      </h2>
      <div className="flex flex-col divide-y divide-hairline rounded-xl bg-sheet shadow-sheet">{children}</div>
      {footnote ? <p className="mt-2 px-1 text-small text-ink-3">{footnote}</p> : null}
    </section>
  );
}

export function Row({ label, detail, children, className }: { label: ReactNode; detail?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-12 items-center gap-4 px-4 py-2.5", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-body text-ink">{label}</div>
        {detail ? <div className="text-small text-ink-2">{detail}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A quiet button inside a settings card. */
export const ROW_BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-surface px-2.5 text-small font-medium text-ink outline-none hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-50";

/** The section's one primary action (Rausch, used sparingly). */
export const PRIMARY_BUTTON =
  "inline-flex h-7 shrink-0 items-center rounded-lg bg-thread-deep px-3 text-small font-medium text-on-thread outline-none hover:bg-thread-deeper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-50";
