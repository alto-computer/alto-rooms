import { useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { GENERIC_ERROR } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useBriefError } from "./briefError";

/** How long "복사했어요" stays after copying. */
export const COPIED_MS = 1500;

/**
 * Copies to the clipboard: `copied` is true for COPIED_MS after a success;
 * `failed.shown` briefly after the clipboard refuses.
 */
export function useCopy(): { copied: boolean; failed: ReturnType<typeof useBriefError>; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const failed = useBriefError();

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn("could not copy", err);
      clearTimeout(timer.current);
      setCopied(false);
      failed.flash();
      return;
    }
    failed.clear();
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return { copied, failed, copy };
}

/** The status line under a copy target: "복사했어요", or a brief 문제가 생겼어요. */
export function CopyStatus({ copied, failed }: { copied: boolean; failed: boolean }) {
  return failed ? (
    <p role="status" className="flex min-h-5 items-center gap-1.5 text-[14px] text-[#c13515]">
      <CircleAlert size={16} aria-hidden />
      {GENERIC_ERROR}
    </p>
  ) : (
    <p role="status" className="min-h-5 text-[14px] text-ink-3">
      {copied ? "복사했어요" : null}
    </p>
  );
}

/**
 * A mono chip that copies `text` on click (showing `label`, default `text`),
 * followed by its status line: "복사했어요" for COPIED_MS, or a brief
 * 문제가 생겼어요 when the clipboard refuses.
 */
export function CopyChip({ text, label = text, className }: { text: string; label?: string; className?: string }) {
  const { copied, failed, copy } = useCopy();

  return (
    <>
      <button
        type="button"
        onClick={() => void copy(text)}
        className={cn(
          "max-w-full truncate rounded-lg border border-[#ddd] bg-white px-3 py-2 font-mono text-[13px] text-ink-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          className,
        )}
      >
        {label}
      </button>
      <CopyStatus copied={copied} failed={failed.shown} />
    </>
  );
}
