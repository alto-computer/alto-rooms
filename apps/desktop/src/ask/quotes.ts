/*
 * Quotes: text picked with "Ask" in a doc or an answer. They travel inside the question as
 * Markdown blockquotes, so roomsd and the agent see one plain question.
 */

export const MAX_QUOTES = 5;
/** A question is at most 8,000 characters; a few quotes plus the question must fit. */
export const MAX_QUOTE_CHARS = 1500;

/** The question as sent: each quote as a blockquote, then what was asked. */
export function withQuotes(quotes: string[], question: string): string {
  const blocks = quotes.map((q) => q.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
  return [...blocks, question].join("\n\n");
}

/** The reverse of `withQuotes`: leading blockquotes are the quotes, the rest is what was asked. */
export function splitQuotes(question: string): { quotes: string[]; text: string } {
  const parts = question.split("\n\n");
  const quotes: string[] = [];
  while (parts.length > 1 && parts[0].split("\n").every((l) => l.startsWith(">"))) {
    quotes.push(parts.shift()!.split("\n").map((l) => l.replace(/^> ?/, "")).join("\n"));
  }
  return { quotes, text: parts.join("\n\n") };
}

/** A picked text as a quote: trimmed, cut to MAX_QUOTE_CHARS; null when there's nothing to quote. */
export function toQuote(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return t.length > MAX_QUOTE_CHARS ? `${t.slice(0, MAX_QUOTE_CHARS - 1)}…` : t;
}
