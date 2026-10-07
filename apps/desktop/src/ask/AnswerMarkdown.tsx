import Markdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";

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
  code: ({ children }) => <code className="rounded bg-[#f2f2f2] px-1 font-mono text-[0.9em]">{children}</code>,
  // A fenced block's <code> sits inside <pre>: the block gets the background, not the code.
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-[#f6f6f6] p-3 font-mono text-[12.5px] leading-[1.5] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[inherit]">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-[#dcdcdc] pl-3 text-ink-2">{children}</blockquote>,
};

/** CommonMark won't close `**턴(AskTurn)**은` (punctuation then a CJK letter); this plugin fixes that. */
const REMARK_PLUGINS = [remarkCjkFriendly];

/** An agent's answer as Markdown, with links and images shown as plain text. */
export function AnswerMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] leading-[1.55] [&>:first-child]:mt-0 [&_hr]:my-3 [&_hr]:border-[#e3e3e3] [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{text}</Markdown>
    </div>
  );
}
