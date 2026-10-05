/** ⌘-click (Ctrl off macOS) or a middle click asks for a new tab, as in a browser. */
export function wantsNewTab(e: { metaKey: boolean; ctrlKey: boolean; button?: number }): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}
