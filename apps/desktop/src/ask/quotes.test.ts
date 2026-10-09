import { describe, expect, it } from "vitest";
import { MAX_QUOTE_CHARS, splitQuotes, toQuote, withQuotes } from "./quotes";

describe("quotes", () => {
  it("go out as blockquotes ahead of the question and come back apart", () => {
    const sent = withQuotes(["a\nb", "c"], "q\n\nmore");
    expect(sent).toBe("> a\n> b\n\n> c\n\nq\n\nmore");
    expect(splitQuotes(sent)).toEqual({ quotes: ["a\nb", "c"], text: "q\n\nmore" });
    expect(withQuotes([], "q")).toBe("q");
  });

  it("a question that is only a quote, or has none, stays as it is", () => {
    expect(splitQuotes("> only a quote")).toEqual({ quotes: [], text: "> only a quote" });
    expect(splitQuotes("plain")).toEqual({ quotes: [], text: "plain" });
  });

  it("picked text is trimmed and cut", () => {
    expect(toQuote("  a  ")).toBe("a");
    expect(toQuote("   ")).toBeNull();
    const cut = toQuote("x".repeat(MAX_QUOTE_CHARS + 10))!;
    expect(cut).toHaveLength(MAX_QUOTE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });
});
