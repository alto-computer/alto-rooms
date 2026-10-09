import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard: `shadcn add/init` rewrites theme variables in styles.css. The Alto tokens must win.
const css = readFileSync(path.resolve(__dirname, "styles.css"), "utf8").replace(/\s+/g, "");

describe("styles.css", () => {
  it.each([
    ["--background", "var(--pane)"],
    ["--foreground", "var(--ink)"],
    ["--primary", "var(--thread-deep)"],
    ["--ring", "var(--ink)"],
    ["--border", "var(--hairline)"],
    ["--sidebar", "var(--desk)"],
    ["--destructive", "var(--error)"],
  ])("maps shadcn %s to the Alto token %s", (name, value) => {
    expect(css).toContain(`${name}:${value};`);
  });

  it("keeps warm paper in light and warm charcoal (not #121212) in dark", () => {
    expect(css).toContain("--pane:#f8f4ee;");
    expect(css).toContain("--ink:#27211e;");
    expect(css).toContain(".dark{--desk:#161311;--pane:#211c19;");
    expect(css).not.toContain("#121212");
  });

  it("sets the UI in the system font and keeps Jost for display only", () => {
    expect(css).toContain("--font-sans:system-ui,");
    expect(css).toContain('--font-display:"Jost",');
    expect(css).toContain("body{font-family:var(--font-sans);");
  });
});

/** App source files (tests, fixtures and the stock shadcn primitives aside). */
function appSources(dir = __dirname): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ["test", "ui", "assets"].includes(e.name) ? [] : appSources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// Agent docs and plugins assume a white page, so their iframes keep one; everything else is themed.
const WHITE_PAGE_FILES = ["ArtifactCard.tsx", "DocView.tsx", "PluginFrame.tsx"];

describe("app code", () => {
  const files = appSources().map((f) => ({ name: path.basename(f), lines: readFileSync(f, "utf8").split("\n") }));
  const offending = (re: RegExp, allow: (name: string) => boolean = () => false) =>
    files.flatMap(({ name, lines }) => (allow(name) ? [] : lines.flatMap((l, i) => (re.test(l) ? [`${name}:${i + 1}: ${l.trim()}`] : []))));

  it("uses colour tokens, not raw hex (black in a mask gradient aside)", () => {
    expect(offending(/#(?!000\b)[0-9a-fA-F]{3,8}\b/)).toEqual([]);
    expect(offending(/\b(text|border|ring|outline)-(white|black)\b|\bbg-black\b/)).toEqual([]);
    expect(offending(/\bbg-white\b/, (name) => WHITE_PAGE_FILES.includes(name))).toEqual([]);
  });

  it("uses the type scale, not arbitrary pixel sizes", () => {
    expect(offending(/\btext-\[\d+(\.\d+)?px\]/)).toEqual([]);
  });
});
