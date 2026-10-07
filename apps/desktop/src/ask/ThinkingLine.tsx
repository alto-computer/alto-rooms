/** The waiting line: a shimmer sweeping over "Thinking", nothing else. */
export function ThinkingLine() {
  return (
    <span className="animate-shimmer bg-linear-to-r from-ink via-[#b4b4b4] to-ink bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-ink-2">
      Thinking
    </span>
  );
}
