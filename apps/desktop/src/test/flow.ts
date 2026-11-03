/**
 * React Flow measures nodes before it shows them; jsdom has no layout, so every element is 100×40.
 * Call from a `beforeAll`.
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
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 100 },
    offsetHeight: { configurable: true, get: () => 40 },
  });
}
