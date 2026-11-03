/**
 * React Flow measures nodes before it shows them; jsdom has no layout, so an element is as wide and
 * tall as its inline style says (a node given a size), or else 100×40, and the canvas itself is
 * 1000×800 at the top left (so a drag in it is nowhere near an edge that pans); a range of text (where
 * a focused editor puts its caret) has no rects. Call from a `beforeAll`.
 */
export function fakeFlowLayout() {
  window.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1;
  };
  const none = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ ...none, toJSON: () => none }) as DOMRect;
  const size = (el: HTMLElement) =>
    el.classList.contains("react-flow") ? { width: 1000, height: 800 } : { width: parseFloat(el.style.width) || 100, height: parseFloat(el.style.height) || 40 };
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return size(this).width;
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return size(this).height;
      },
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const { width, height } = size(this);
    const box = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height };
    return { ...box, toJSON: () => box } as DOMRect;
  };
}
