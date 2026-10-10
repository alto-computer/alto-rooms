import { useId } from "react";

/**
 * The brand mark: the app icon's red wool ball, flat, with its wraps cut out as gaps so they show the
 * surface behind it in either theme, and the thread trailing out. Two drawings, one per size, so the
 * gaps stay crisp. Each wrap is a circle on the ball seen at an angle, so each is one elliptical arc.
 */
export function WoolGlyph({ size, className }: { size: 16 | 24; className?: string }) {
  const s = size === 16 ? SMALL : LARGE;
  const mask = useId();
  const [cx, cy, r] = s.ball;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden className={className}>
      <mask id={mask}>
        <circle cx={cx} cy={cy} r={r} fill="white" />
        <g fill="none" strokeLinecap="round">
          {s.under.map((d) => (
            <path key={d} d={d} stroke="black" strokeWidth={s.gap} />
          ))}
          <path d={s.band} stroke="white" strokeWidth={s.bandWidth} strokeLinecap="butt" />
          {s.over.map((d) => (
            <path key={d} d={d} stroke="black" strokeWidth={s.gap} />
          ))}
        </g>
      </mask>
      <path d={s.thread} fill="none" stroke="var(--thread)" strokeWidth={s.threadWidth} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={r} fill="var(--thread)" mask={`url(#${mask})`} />
    </svg>
  );
}

type Drawing = {
  ball: [cx: number, cy: number, r: number];
  /** Wraps under the crossing band, cut as gaps. */
  under: string[];
  /** The crossing band's body, which covers the wraps under it. */
  band: string;
  bandWidth: number;
  /** The band's own wraps. */
  over: string[];
  gap: number;
  thread: string;
  threadWidth: number;
};

const SMALL: Drawing = {
  ball: [9.5, 7, 5.75],
  under: ["M5.88 11.46A5.49 2.45 109.44 0 1 9.48 1.25", "M9.51 12.75A5.49 2.45 109.44 1 1 13.12 2.53"],
  band: "M4.33 4.47A5.75 1.51 206.03 0 1 14.67 9.52",
  bandWidth: 3.45,
  over: ["M4.86 3.61A5.67 1.49 206.03 0 1 15.03 8.57", "M3.97 5.42A5.67 1.49 206.03 1 1 14.14 10.39"],
  gap: 0.9,
  thread: "M5.6 11.2C4.4 12.4 3.6 13.6 4.6 14.2C5.6 14.8 8 14.6 10 14.4S13.4 14.2 15 14.7",
  threadWidth: 1.5,
};

const LARGE: Drawing = {
  ball: [13.75, 10, 8.5],
  under: [
    "M6.92 15.06A7.36 3.29 109.44 0 1 11.61 1.77",
    "M10.91 18.01A8.5 3.8 109.44 0 1 16.57 1.98",
    "M15.88 18.23A7.36 3.29 109.44 1 1 20.57 4.93",
  ],
  band: "M6.11 6.27A8.5 2.23 206.03 0 1 21.39 13.73",
  bandWidth: 5.1,
  over: ["M6.89 4.98A8.38 2.2 206.03 0 1 21.93 12.33", "M5.58 7.67A8.38 2.2 206.03 1 1 20.61 15.01"],
  gap: 1,
  thread: "M8 16.2C6.4 17.8 5.2 19.4 6.6 20.4C8 21.3 11.4 21 14.4 20.7S19.6 20.6 22.4 21.4",
  threadWidth: 1.75,
};
