import { describe, expect, it } from "vitest";
import { buildIndex, offsetOf, rangeAt } from "./surfaceIndex";

/** The highlight plugin's own index rules, kept apart so a change on either side shows up here. */
function pluginIndex(root: Node): string {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);
  let text = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!skip.has(n.parentElement!.tagName)) text += n.nodeValue;
      return;
    }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(root);
  return text;
}

const ANSWER = `<div><p>요약: <strong>p95</strong>는 118 ms입니다.</p>
<div class="code"><div><span>ts</span><button aria-label="Copy code"></button></div><pre><code>const a = 1;\nlet b = a;</code></pre></div>
<table><thead><tr><th>이름</th><th>값</th></tr></thead><tbody><tr><td>alpha</td><td>1</td></tr></tbody></table>
<p>See the report (https://example.com/r)</p><style>.x{}</style><script>bad()</script></div>`;

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("surfaceIndex", () => {
  it("gives the same text as the plugin's index for an answer with code, a table, a link and Korean", () => {
    const root = mount(ANSWER);
    const { text } = buildIndex(root);
    expect(text).toBe(pluginIndex(root));
    expect(text).toContain("요약: p95는 118 ms입니다.");
    expect(text).toContain("const a = 1;\nlet b = a;");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain(".x{}");
  });

  it("maps offsets to DOM ranges over exactly that slice, and back", () => {
    const root = mount(ANSWER);
    const index = buildIndex(root);
    for (const word of ["p95", "118 ms", "let b", "alpha", "example.com", "이름값"]) {
      const start = index.text.indexOf(word);
      expect(start, word).toBeGreaterThanOrEqual(0);
      const range = rangeAt(index, start, start + word.length)!;
      expect(range.toString(), word).toBe(word);
      expect(offsetOf(index, range.startContainer, range.startOffset)).toBe(start);
      expect(offsetOf(index, range.endContainer, range.endOffset)).toBe(start + word.length);
    }
  });

  it("refuses offsets outside the text", () => {
    const index = buildIndex(mount("<p>abc</p>"));
    expect(rangeAt(index, 0, 4)).toBeNull();
    expect(rangeAt(index, 2, 2)).toBeNull();
    expect(rangeAt(index, -1, 2)).toBeNull();
    expect(rangeAt(index, 0, 3)!.toString()).toBe("abc");
  });

  it("places an element boundary point at the next text", () => {
    const root = mount("<div><p>ab</p><p>cd</p></div>");
    const index = buildIndex(root);
    expect(offsetOf(index, root, 1)).toBe(2);
    expect(offsetOf(index, root, 2)).toBe(4);
  });
});
