import type { ReactNode } from "react";
import { Calendar, FileText, Folder, Inbox, Lightbulb, RefreshCw, type LucideIcon } from "lucide-react";
import { ClewPeek } from "@/components/ClewPeek";
import { useInfo, useRoomList } from "@/data/hooks";
import { INBOX_ID } from "@/lib/drag";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CopyStatus, useCopy } from "./CopyChip";

/**
 * The ONBOARD.md path an agent is pointed at: `~/rooms/ONBOARD.md` only when
 * the home is exactly `/Users/<name>/rooms` or `/home/<name>/rooms` (where
 * `~` is certain); the absolute path otherwise.
 */
export function onboardPromptPath(home: string): string {
  const base = home.replace(/\/+$/, "");
  return /^\/(Users|home)\/[^/]+\/rooms$/.test(base) ? "~/rooms/ONBOARD.md" : `${base}/ONBOARD.md`;
}

/** The first-run prompt; the chip shows and copies exactly this. */
export function onboardPrompt(home: string): string {
  return `Read ${onboardPromptPath(home)} and follow it.`;
}

/** "Try telling your agent": each card copies its own text. */
export const EXAMPLE_PROMPTS: readonly { icon: LucideIcon; text: string }[] = [
  { icon: FileText, text: "Turn this result into an HTML report and put it in the right room" },
  { icon: RefreshCw, text: "Sort my rooms again, going back 30 days" },
  { icon: Calendar, text: "Turn today's conversation into an HTML review and put it in today's Journal" },
];

/** First run: synced, and no rooms besides the inbox. False before the first sync, when nothing can be told yet. */
export function useFirstRun(): boolean {
  const info = useInfo();
  const rooms = useRoomList();
  return info !== null && rooms.every((r) => r.id === INBOX_ID);
}

/**
 * The first-run welcome page (no rooms besides inbox): the one line to paste
 * into an agent, the concepts, example prompts and tips. Renders nothing
 * before the first sync.
 */
export function OnboardingCard() {
  const info = useInfo();
  if (!info) return null;
  return <Welcome home={info.home} />;
}

const H2 = "text-heading font-medium text-ink";
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

/** The first-run welcome page. A container, so its grids follow its own width, not the window's. */
function Welcome({ home }: { home: string }) {
  return (
    <div data-testid="welcome" className="@container mx-auto flex w-full max-w-[760px] flex-col gap-10">
      <header className="flex flex-col items-start gap-3">
        <ClewPeek className="mb-1 w-[120px]" />
        <h1 className="font-display text-display font-medium tracking-[-0.01em] text-ink">Welcome to Rooms</h1>
        <p className="text-heading text-ink-2">Rooms gathers the HTML your agents write into topic rooms.</p>
      </header>

      <StartSection home={home} />

      <section aria-labelledby="welcome-concepts" className="flex flex-col gap-4">
        <h2 id="welcome-concepts" className={H2}>
          Good to know
        </h2>
        <ul data-testid="welcome-concepts" className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-3">
          <Concept icon={Folder} name="Rooms">
            One folder per topic. Any HTML in <code className="font-mono text-body">~/rooms/&lt;room&gt;/</code> becomes a card right away.
          </Concept>
          <Concept icon={Calendar} name="Journal">
            Each day's artifacts, next to your own plan and review notes.
          </Concept>
          <Concept icon={Inbox} name="inbox">
            Artifacts without a room wait here. Drag one onto a room on the left to move it.
          </Concept>
        </ul>
      </section>

      <section aria-labelledby="welcome-examples" className="flex flex-col gap-4">
        <h2 id="welcome-examples" className={H2}>
          Try telling your agent
        </h2>
        <ExamplePile />
      </section>

      <aside aria-label="Tip" className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface px-5 py-4">
        <p className="flex items-center gap-1.5 text-small font-semibold tracking-[0.08em] text-ink-2">
          <Lightbulb size={16} strokeWidth={1.75} aria-hidden />Tip
        </p>
        <p className="text-body text-ink">
          ⌘K finds rooms and artifacts. ⌘B hides the sidebar. Hover a card and press ↗ to open it in a new tab.
        </p>
      </aside>
    </div>
  );
}

/** "Get started": the prompt chip and the page's one primary action, Copy. Both copy the prompt. */
function StartSection({ home }: { home: string }) {
  const { copied, failed, copy } = useCopy();
  const prompt = onboardPrompt(home);
  return (
    <section aria-labelledby="welcome-start" className="flex flex-col gap-3">
      <h2 id="welcome-start" className={H2}>
        Get started
      </h2>
      <div className="flex max-w-full items-center gap-2">
        <button
          type="button"
          aria-label="Copy prompt"
          data-testid="welcome-prompt"
          onClick={() => void copy(prompt)}
          className={cn(
            "min-w-0 truncate rounded-lg border border-hairline bg-sheet px-3.5 py-2.5 text-left font-mono text-body text-ink hover:bg-surface",
            FOCUS,
          )}
          title={prompt}
        >
          {prompt}
        </button>
        <button
          type="button"
          aria-label="Copy prompt"
          data-testid="welcome-copy"
          onClick={() => void copy(prompt)}
          className={cn(
            "h-10 shrink-0 rounded-lg bg-thread-deep px-4 text-lead font-medium text-on-thread hover:bg-thread-deeper",
            FOCUS,
          )}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {failed.shown ? <CopyStatus copied={false} failed /> : null}
      <p className="text-body text-ink-2">
        Paste this into Claude Code or Codex. Your agent finds the HTML it wrote in the last 14 days and sorts it into topic rooms. It only adds links; your files stay where they are.
      </p>
    </section>
  );
}

function Concept({ icon: Icon, name, children }: { icon: LucideIcon; name: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5">
      <Icon size={20} strokeWidth={1.75} className="text-ink" aria-hidden />
      <p className="text-lead font-medium text-ink">{name}</p>
      <p className="text-body leading-[1.5] text-ink-2">{children}</p>
    </li>
  );
}

/**
 * The example prompts as a casual pile: the first two side by side, the third
 * tucked under them, each slightly tilted. Below 720px of page width they
 * stack straight. Hover straightens and lifts a card (instantly under
 * reduced motion).
 */
function ExamplePile() {
  // Layout per card (on the <li>) and tilt (on the button, so hover can straighten it).
  const place = [
    "z-[2] @min-[720px]:mt-3",
    "z-[2] @min-[720px]:-ml-3",
    "z-[1] @min-[720px]:col-span-2 @min-[720px]:-mt-4 @min-[720px]:justify-self-center",
  ];
  const tilt = ["@min-[720px]:rotate-[-2deg]", "@min-[720px]:rotate-[1.5deg]", "@min-[720px]:rotate-[-1deg]"];
  return (
    <ul
      data-testid="welcome-examples"
      className="flex flex-col gap-3 pb-2 @min-[720px]:grid @min-[720px]:grid-cols-[300px_300px] @min-[720px]:items-start @min-[720px]:justify-center @min-[720px]:gap-0"
    >
      {EXAMPLE_PROMPTS.map((ex, i) => (
        <li key={ex.text} className={cn("relative focus-within:z-[3] hover:z-[3] @min-[720px]:w-[300px]", place[i])}>
          <ExampleCard icon={ex.icon} text={ex.text} tilt={tilt[i]} />
        </li>
      ))}
    </ul>
  );
}

function ExampleCard({ icon: Icon, text, tilt }: { icon: LucideIcon; text: string; tilt: string }) {
  const { copied, failed, copy } = useCopy();
  return (
    <button
      type="button"
      aria-label={`Copy example: ${text}`}
      data-testid="example-card"
      onClick={() => void copy(text)}
      className={cn(
        "relative flex w-full items-start gap-2.5 rounded-xl border border-hairline bg-sheet px-[18px] py-4 text-left text-lead text-ink shadow-float",
        "transition-[rotate,translate] duration-150 ease-out motion-reduce:transition-none",
        tilt,
        "@min-[720px]:hover:rotate-0 @min-[720px]:hover:-translate-y-1",
        FOCUS,
      )}
    >
      <Icon size={18} strokeWidth={1.75} className="mt-[3px] shrink-0 text-ink" aria-hidden />
      <span>{text}</span>
      <span role="status" className={cn("absolute right-3 bottom-1 text-small", failed.shown ? "text-error" : "text-ink-3")}>
        {failed.shown ? GENERIC_ERROR : copied ? "Copied" : null}
      </span>
    </button>
  );
}
