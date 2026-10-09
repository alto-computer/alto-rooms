import { isValidElement, memo, useRef, type ReactNode } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useCopy } from "@/views/CopyChip";

/** The language a fenced block names (```ts → "ts"), read off its <code> child. */
function fenceLanguage(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  return /\blanguage-([\w+#.-]+)/.exec(children.props.className ?? "")?.[1] ?? null;
}

/** A fenced block: its language and a copy button on a header row, the code scrolling sideways under it. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopy();
  const lang = fenceLanguage(children);
  const onCopy = async () => {
    if (!(await copy(pre.current?.textContent?.replace(/\n$/, "") ?? ""))) toast.error("Couldn't copy", { id: "ask-copy" });
  };
  const Icon = copied ? Check : Copy;
  return (
    <div className="group/code my-2 overflow-hidden rounded-lg bg-[#f6f6f6]">
      <div className="flex h-7 items-center justify-between pr-1 pl-3 text-[11.5px] text-ink-2">
        <span className="font-mono">{lang ?? ""}</span>
        <button
          type="button"
          aria-label="Copy code"
          data-copied={copied ? "true" : undefined}
          onClick={() => void onCopy()}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-[#ebebeb] hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
        >
          <Icon size={13} />
        </button>
      </div>
      <pre
        ref={pre}
        className="overflow-x-auto px-3 pt-0 pb-3 font-mono text-[12.5px] leading-[1.5] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[inherit]"
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * Compact typography for an answer in the ask sheet. Agent output may echo untrusted content:
 * never render a link or an image, only their text.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <>
      {children}
      {href && /^https?:\/\//i.test(href) ? <span className="text-ink-2"> ({href})</span> : null}
    </>
  ),
  img: ({ alt }) => <>{alt ?? ""}</>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-[16px] leading-snug font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-[14.5px] leading-snug font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-[13.5px] leading-snug font-semibold">{children}</h3>,
  code: ({ children, className }) => (
    <code className={className ?? "rounded bg-[#f2f2f2] px-1 font-mono text-[0.9em]"}>{children}</code>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-[#dcdcdc] pl-3 text-ink-2">{children}</blockquote>,
  // A wide table scrolls inside its own frame instead of squeezing every column to a word per line.
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-[#e3e3e3]">
      <table className="w-full border-collapse text-[12.5px] leading-[1.45]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[#f6f6f6]">{children}</thead>,
  tr: ({ children }) => <tr className="border-t border-[#ececec] first:border-t-0">{children}</tr>,
  // keep-all: Korean breaks between words, not inside them; inline code in a cell never wraps.
  th: ({ children, style }) => (
    <th style={style} className="px-2.5 py-1.5 text-left align-bottom font-semibold break-keep whitespace-nowrap">{children}</th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="min-w-[4.5em] px-2.5 py-1.5 align-top break-keep [&_code]:whitespace-nowrap">{children}</td>
  ),
  del: ({ children }) => <del className="text-ink-2">{children}</del>,
  input: ({ checked }) => (
    <input type="checkbox" checked={!!checked} readOnly disabled className="mr-1.5 size-3 translate-y-[1px] accent-ink" />
  ),
};

/**
 * CJK: CommonMark won't close `**턴(AskTurn)**은` (punctuation then a CJK letter); remark-cjk-friendly fixes that.
 * GFM: tables, task lists, ~~strikethrough~~. A single `~` stays text, as in "1~2개".
 */
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkCjkFriendly, [remarkGfm, { singleTilde: false }]];

/** An agent's answer as Markdown, with links and images shown as plain text. Memoized: a long thread re-renders often. */
export const AnswerMarkdown = memo(function AnswerMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] leading-[1.55] [&>:first-child]:mt-0 [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-0.5 [&_hr]:my-3 [&_hr]:border-[#e3e3e3] [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{text}</Markdown>
    </div>
  );
});
