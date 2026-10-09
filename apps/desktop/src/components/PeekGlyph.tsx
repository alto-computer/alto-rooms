/**
 * The brand mark, "Peek": Clew's head over the thread. Two drawings, one per size, so the
 * strokes stay crisp. Ink is `currentColor` (it follows the theme); the thread is Rausch.
 */
export function PeekGlyph({ size, className }: { size: 16 | 24; className?: string }) {
  const s = size === 16 ? SMALL : LARGE;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden className={className}>
      <g transform={`translate(0 ${-size / 10})`} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {s.strokes.map(([d, w]) => (
          <path key={d} d={d} strokeWidth={w} />
        ))}
        <path d={s.nose} fill="currentColor" stroke="none" />
        <path d={s.thread} stroke="var(--thread)" strokeWidth={s.threadWidth} />
      </g>
    </svg>
  );
}

type Drawing = { strokes: [d: string, width: number][]; nose: string; thread: string; threadWidth: number };

const SMALL: Drawing = {
  strokes: [
    ["M1.6 12.3C1.4 10.3 1.9 8.4 3.1 7.3C4.3 6.1 6 5.6 8 5.6S11.7 6.1 12.9 7.3C14.1 8.4 14.6 10.3 14.4 12.3", 1.5],
    ["M2.1 8.8A.75 .75 0 1 1 3 7.4", 1.5],
    ["M13.9 8.8A.75 .75 0 1 0 13 7.4", 1.5],
    ["M4.4 8.9Q5.2 9.7 6 8.9", 1.25],
    ["M10 8.9Q10.8 9.7 11.6 8.9", 1.25],
    ["M2.9 11.3L4.4 11.5", 1],
    ["M13.1 11.3L11.6 11.5", 1],
  ],
  nose: "M6.4 9.8C6.4 9 9.6 9 9.6 9.8C9.6 10.6 8.6 11.3 8 11.3S6.4 10.6 6.4 9.8Z",
  thread: "M.9 13.2C2.3 12.4 3.5 12.4 4.9 13.2S7.6 14 9 13.2 11.7 12.4 13.1 13.2 14.6 13.7 15.1 13.4",
  threadWidth: 1.5,
};

const LARGE: Drawing = {
  strokes: [
    ["M2.4 18.4C2.2 15.4 2.9 12.6 4.6 10.9C6.4 9.1 9 8.4 12 8.4S17.6 9.1 19.4 10.9C21.1 12.6 21.8 15.4 21.6 18.4", 1.75],
    ["M3.2 13A1.1 1.1 0 1 1 4.5 11", 1.75],
    ["M20.8 13A1.1 1.1 0 1 0 19.5 11", 1.75],
    ["M6.7 13.2Q7.95 14.4 9.2 13.2", 1.5],
    ["M14.8 13.2Q16.05 14.4 17.3 13.2", 1.5],
    ["M10 16.8C10.5 17.9 11.7 17.8 12 16.8C12.3 17.8 13.5 17.9 14 16.8", 1.25],
    ["M4.6 16.2L7.2 16.5", 1.25],
    ["M19.4 16.2L16.8 16.5", 1.25],
  ],
  nose: "M10 14.5C10 13.5 14 13.5 14 14.5C14 15.4 12.8 16.2 12 16.2S10 15.4 10 14.5Z",
  thread: "M1.25 19.6C3.4 18.4 5.2 18.4 7.3 19.6S11.4 20.8 13.5 19.6 17.6 18.4 19.7 19.6 22 20.4 22.75 19.8",
  threadWidth: 1.75,
};
