import { useRooms } from "@/data/hooks";
import { CopyChip } from "./CopyChip";

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

/**
 * Hands the user one line to paste into an agent. Full form on first run (no
 * rooms besides inbox), compact at the top of the New tab when opened from
 * the sidebar's "에이전트로 정리하기". Renders nothing before the first sync.
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
        <CopyChip text={COMPACT_PROMPT} />
      </section>
    );
  }

  return (
    <section className="flex flex-col items-start gap-3">
      <h1 className="text-[32px] font-medium text-ink">이 한 줄을 에이전트에게 붙여넣으세요</h1>
      <p className="text-[17px] text-ink-2">
        에이전트가 최근 14일 동안 만든 HTML을 주제별 방으로 정리해요. 원본은 그대로 두고 링크만 만들어요.
      </p>
      <div className="mt-3 flex max-w-full flex-col items-start gap-1">
        <CopyChip text={onboardPrompt(info.home)} />
      </div>
      <p className="text-[14px] text-ink-3">Claude Code나 Codex에 붙여넣으면 돼요.</p>
    </section>
  );
}
