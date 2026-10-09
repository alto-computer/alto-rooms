/** The waiting line: a shimmer sweeping over "Thinking", or over what the agent is doing now. Nothing else. */
export function ThinkingLine({ label = "Thinking" }: { label?: string }) {
  return (
    <span className="min-w-0 truncate animate-shimmer bg-linear-to-r from-ink via-[#b4b4b4] to-ink bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-ink-2">
      {label}
    </span>
  );
}
