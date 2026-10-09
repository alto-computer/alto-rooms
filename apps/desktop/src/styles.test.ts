import { readFileSync } from "node:fs";
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
