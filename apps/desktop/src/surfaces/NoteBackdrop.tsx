/*
 * The paint behind a note. A note is a plain <textarea> (no editor, by design), and the browser
 * gives no DOM ranges inside one, so its text is mirrored into a div under it, in transparent ink
 * with the same font, wrapping, size and scroll, and plugin ranges are painted there with
 * CSS.highlights. The textarea's value, keys and autosave are untouched. Mounted only while a
 * plugin with `surfaces.text` is on; without one the note is the textarea alone, as before.
 *
 * The mirror stays selectable. WebKit moves each highlight range to its visible positions
 * (Document::updateHighlightPositions), which skip `user-select: none` text, so under that
 * style both ends landed on the mirror's neighbours and the paint covered the whole note. The
 * textarea over it takes every pointer and key, so the mirror is only reachable by a page-wide
 * Select All.
 */
import { useEffect, useRef, type RefObject } from "react";
import { surfaceHub, surfaceKey, type SurfaceId } from "./surfaceHub";

/** How long the text stays still before plugins hear it; the paint follows each keystroke before that. */
export const NOTE_QUIET_MS = 300;

export function NoteBackdrop({ id, text, textarea, className }: {
  id: SurfaceId;
  text: string;
  /** The textarea this sits under; its font classes come in `className`, its size and scroll are read live. */
  textarea: RefObject<HTMLTextAreaElement | null>;
  className: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const key = surfaceKey(id);
  const latest = useRef(id);
  latest.current = id;
  useEffect(() => {
    const el = root.current;
    const ta = textarea.current;
    if (!el || !ta) return;
    const sync = () => {
      el.scrollTop = ta.scrollTop;
      el.scrollLeft = ta.scrollLeft;
    };
    // The textarea's content box: a scrollbar that comes or goes narrows the text, and the mirror must wrap where it does.
    const fit = () => {
      el.style.width = `${ta.clientWidth}px`;
      el.style.height = `${ta.clientHeight}px`;
      sync();
    };
    const reveal = (range: Range) => {
      const top = range.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
      sync();
    };
    const open = () => surfaceHub.open(latest.current, el, { quietMs: NOTE_QUIET_MS, reveal });
    fit();
    open();
    const observer = new MutationObserver(open);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    sizes?.observe(ta);
    ta.addEventListener("scroll", sync);
    return () => {
      observer.disconnect();
      sizes?.disconnect();
      ta.removeEventListener("scroll", sync);
      surfaceHub.close(key);
    };
  }, [key, textarea]);
  return (
    <div ref={root} data-note-backdrop={key} aria-hidden className={`pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-transparent ${className}`}>
      {/* The textarea's value has its line breaks normalized; offsets into it mean the same here only if this text does too. */}
      {text.replace(/\r\n?/g, "\n")}
      {/* A trailing newline in the text ends a line only when something follows it, as it does in the textarea. */}
      <br />
    </div>
  );
}
