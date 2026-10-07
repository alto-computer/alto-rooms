import Markdown, { type Components } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";

/** Agent output may echo untrusted content: never render a link or an image, only their text. */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <>
      {children}
      {href && /^https?:\/\//i.test(href) ? <span className="text-ink-2"> ({href})</span> : null}
    </>
  ),
  img: ({ alt }) => <>{alt ?? ""}</>,
};

/** CommonMark won't close `**턴(AskTurn)**은` (punctuation then a CJK letter); this plugin fixes that. */
const REMARK_PLUGINS = [remarkCjkFriendly];

/** An agent's answer as Markdown, with links and images shown as plain text. */
export function AnswerMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] leading-[1.55] [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{text}</Markdown>
    </div>
  );
}
