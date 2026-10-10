/*
 * The flat text of a host surface and the map back to its text nodes. Offsets a plugin stores
 * are offsets into `text`, so the rules here match the highlight plugin's content-script index:
 * every text node in document order, except under script, style, noscript, textarea and template,
 * joined with nothing in between.
 */

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);

export type TextIndex = {
  text: string;
  /** Each text node and where its data starts in `text`, ascending. */
  map: { node: Text; start: number }[];
};

export function buildIndex(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      return !n.nodeValue || !p || SKIP.has(p.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const map: TextIndex["map"] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    map.push({ node: n as Text, start: text.length });
    text += n.nodeValue;
  }
  return { text, map };
}

/** The offset in `index.text` of a boundary point, or of the first indexed text after it. */
export function offsetOf(index: TextIndex, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const seg = index.map.find((s) => s.node === node);
    if (seg) return seg.start + Math.min(offset, seg.node.data.length);
  }
  const at = (node.ownerDocument ?? (node as Document)).createRange();
  at.setStart(node, offset);
  let lo = 0;
  let hi = index.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at.comparePoint(index.map[mid].node, 0) >= 0) hi = mid;
    else lo = mid + 1;
  }
  return lo < index.map.length ? index.map[lo].start : index.text.length;
}

/**
 * The text node and offset for `offset` in `index.text`. A start point takes the node holding the
 * character at `offset`; an end point takes the node holding the character before it.
 */
function pointAt(index: TextIndex, offset: number, side: "start" | "end"): { node: Text; offset: number } {
  const bias = side === "start" ? 1 : 0;
  let lo = 0;
  let hi = index.map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.map[mid].start < offset + bias) lo = mid;
    else hi = mid - 1;
  }
  const seg = index.map[lo];
  return { node: seg.node, offset: Math.min(offset - seg.start, seg.node.data.length) };
}

/** A DOM range over `text.slice(start, end)`, or null when the offsets fall outside the text. */
export function rangeAt(index: TextIndex, start: number, end: number): Range | null {
  if (!index.map.length || start < 0 || end <= start || end > index.text.length) return null;
  const a = pointAt(index, start, "start");
  const b = pointAt(index, end, "end");
  const r = a.node.ownerDocument.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}
