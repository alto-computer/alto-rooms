import type { ReactNode } from "react";
import { Calendar, FileText, Folder, Inbox, Lightbulb, RefreshCw, type LucideIcon } from "lucide-react";
import clewPeek from "@/assets/clew-peek.svg";
import { useRooms } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CopyChip, CopyStatus, useCopy } from "./CopyChip";

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
  return `${onboardPromptPath(home)} 를 읽고 따라 해줘`;
}

/** The short re-run prompt for an agent that already has the rooms skill. */
export const COMPACT_PROMPT = "rooms 정리해줘";

/** "에이전트에게 이렇게 말해 보세요": each card copies its own text. */
export const EXAMPLE_PROMPTS: readonly { icon: LucideIcon; text: string }[] = [
  { icon: FileText, text: "이번 결과를 HTML 리포트로 만들어서 알맞은 방에 넣어줘" },
  { icon: RefreshCw, text: "rooms 다시 정리해줘. 30일치로" },
  { icon: Calendar, text: "오늘 대화를 복습용 HTML로 만들어서 오늘 Journal에 넣어줘" },
];

/**
 * Hands the user one line to paste into an agent. Full form on first run (no
 * rooms besides inbox): a welcome page with the prompt, the concepts, example
 * prompts and tips. Compact at the top of the New tab when opened from the
 * sidebar's "에이전트로 정리하기": there it offers both the ONBOARD prompt
 * (first time, or another agent without the skill) and the short re-run line.
 * Renders nothing before the first sync.
 */
export function OnboardingCard({ compact = false }: { compact?: boolean }) {
  const { info } = useRooms();
  if (!info) return null;

  if (compact) {
    return (
      <section
        aria-label="에이전트로 다시 정리하기"
        className="flex flex-col items-start gap-2 rounded-[14px] border border-[#ddd] bg-white px-5 py-[18px]"
      >
        <p className="text-[15px] font-medium text-ink">에이전트로 다시 정리하기</p>
        <div className="flex max-w-full flex-col items-start gap-1">
          <p className="text-[13px] text-[#929292]">처음이거나 다른 에이전트라면</p>
          <CopyChip text={onboardPrompt(info.home)} />
        </div>
        <div className="flex max-w-full flex-col items-start gap-1">
          <p className="text-[13px] text-[#929292]">스킬이 이미 있으면</p>
          <CopyChip text={COMPACT_PROMPT} />
        </div>
      </section>
    );
  }

  return <Welcome home={info.home} />;
}

const H2 = "text-[18px] font-medium text-ink";
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

/** The first-run welcome page. A container, so its grids follow its own width, not the window's. */
function Welcome({ home }: { home: string }) {
  return (
    <div data-testid="welcome" className="@container mx-auto flex w-full max-w-[760px] flex-col gap-10">
      <header className="flex flex-col items-start gap-3">
        <img src={clewPeek} alt="" width={120} className="mb-1 h-auto w-[120px]" />
        <h1 className="text-[32px] font-medium tracking-[-0.01em] text-ink">Rooms에 오신 걸 환영해요</h1>
        <p className="text-[17px] text-ink-2">에이전트가 만든 HTML을 주제별 방에 모아 보는 곳이에요.</p>
      </header>

      <StartSection home={home} />

      <section aria-labelledby="welcome-concepts" className="flex flex-col gap-4">
        <h2 id="welcome-concepts" className={H2}>
          알아두면 좋은 것
        </h2>
        <ul data-testid="welcome-concepts" className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-3">
          <Concept icon={Folder} name="방">
            주제별 폴더예요. <code className="font-mono text-[13px]">~/rooms/&lt;방&gt;/</code>에 HTML이 들어오면 바로 카드가 돼요.
          </Concept>
          <Concept icon={Calendar} name="Journal">
            날짜별로 그날 만든 문서와 내 계획·회고 노트를 모아요.
          </Concept>
          <Concept icon={Inbox} name="inbox">
            방을 못 정한 문서가 기다리는 곳. 왼쪽 방으로 끌어다 놓으면 옮겨져요.
          </Concept>
        </ul>
      </section>

      <section aria-labelledby="welcome-examples" className="flex flex-col gap-4">
        <h2 id="welcome-examples" className={H2}>
          에이전트에게 이렇게 말해 보세요
        </h2>
        <ExamplePile />
      </section>

      <aside aria-label="팁" className="flex flex-col gap-2 rounded-[14px] border border-[#ddd] bg-[#f7f7f7] px-5 py-4">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.08em] text-ink-2">
          <Lightbulb size={16} strokeWidth={1.75} aria-hidden />팁
        </p>
        <p className="text-[14px] text-ink">
          ⌘K로 방과 문서를 찾고, ⌘B로 사이드바를 접어요. 카드에 마우스를 올리고 ↗를 누르면 새 탭에서 크게 열려요.
        </p>
      </aside>
    </div>
  );
}

/** "시작하기": the prompt chip and the page's one primary action, 복사. Both copy the prompt. */
function StartSection({ home }: { home: string }) {
  const { copied, failed, copy } = useCopy();
  const prompt = onboardPrompt(home);
  return (
    <section aria-labelledby="welcome-start" className="flex flex-col gap-3">
      <h2 id="welcome-start" className={H2}>
        시작하기
      </h2>
      <div className="flex max-w-full items-center gap-2">
        <button
          type="button"
          aria-label="프롬프트 복사"
          data-testid="welcome-prompt"
          onClick={() => void copy(prompt)}
          className={cn(
            "min-w-0 truncate rounded-lg border border-[#ddd] bg-white px-3.5 py-2.5 text-left font-mono text-[14px] text-ink hover:bg-[#f7f7f7]",
            FOCUS,
          )}
          title={prompt}
        >
          {prompt}
        </button>
        <button
          type="button"
          aria-label="프롬프트 복사"
          data-testid="welcome-copy"
          onClick={() => void copy(prompt)}
          className={cn(
            "h-10 shrink-0 rounded-lg bg-thread-deep px-4 text-[15px] font-medium text-white hover:bg-[var(--thread-deeper)]",
            FOCUS,
          )}
        >
          {copied ? "복사했어요" : "복사"}
        </button>
      </div>
      {failed.shown ? <CopyStatus copied={false} failed /> : null}
      <p className="text-[14px] text-ink-2">
        Claude Code나 Codex에 붙여넣으면, 에이전트가 최근 14일 동안 만든 HTML을 찾아 주제별 방으로 정리해요. 원본은 그대로 두고 링크만 만들어요.
      </p>
    </section>
  );
}

function Concept({ icon: Icon, name, children }: { icon: LucideIcon; name: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5">
      <Icon size={20} strokeWidth={1.75} className="text-ink" aria-hidden />
      <p className="text-[15px] font-medium text-ink">{name}</p>
      <p className="text-[14px] leading-[1.5] text-ink-2">{children}</p>
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
      aria-label={`예시 복사: ${text}`}
      data-testid="example-card"
      onClick={() => void copy(text)}
      className={cn(
        "relative flex w-full items-start gap-2.5 rounded-[14px] border border-[#ddd] bg-white px-[18px] py-4 text-left text-[15px] text-ink shadow-float",
        "transition-[rotate,translate] duration-150 ease-out motion-reduce:transition-none",
        tilt,
        "@min-[720px]:hover:rotate-0 @min-[720px]:hover:-translate-y-1",
        FOCUS,
      )}
    >
      <Icon size={18} strokeWidth={1.75} className="mt-[3px] shrink-0 text-ink" aria-hidden />
      <span>{text}</span>
      <span role="status" className={cn("absolute right-3 bottom-1 text-[12px]", failed.shown ? "text-[#c13515]" : "text-ink-3")}>
        {failed.shown ? GENERIC_ERROR : copied ? "복사했어요" : null}
      </span>
    </button>
  );
}
