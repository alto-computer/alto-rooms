import { useEffect, useState, type RefObject } from "react";

/** Whether an agent page is light or dark, by its own background, as the bridge roomsd appends to it reports. */
export type DocTone = "light" | "dark";

/** The bridge's message from a doc frame: `{roomsTone: 1, tone}`. Anything else is null. */
export function readToneMessage(data: unknown): DocTone | null {
  if (!data || typeof data !== "object" || (data as { roomsTone?: unknown }).roomsTone !== 1) return null;
  const { tone } = data as { tone?: unknown };
  return tone === "light" || tone === "dark" ? tone : null;
}

/**
 * Whether a page takes the dark-mode dim (`--doc-filter`, `--thumb-filter`; both `none` in light mode).
 * A page that said it is dark keeps its colours. One that can't say (an image, a PDF, a page still
 * loading) counts as light: most agent pages are.
 */
export const dimsInDark = (tone: DocTone | null): boolean => tone !== "dark";

/** The tone the page in `frame` last reported; null until it does. Only that frame's own messages count. */
export function useFrameTone(frame: RefObject<HTMLIFrameElement | null>): DocTone | null {
  const [tone, setTone] = useState<DocTone | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const t = readToneMessage(e.data);
      if (t) setTone(t);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);
  return tone;
}
