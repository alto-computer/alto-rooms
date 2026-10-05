import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard: `shadcn add/init` rewrites theme variables in styles.css. The Alto tokens must win.
const css = readFileSync(path.resolve(__dirname, "styles.css"), "utf8").replace(/\s+/g, "");

describe("styles.css", () => {
  it.each([
    ["--background", "var(--canvas)"],
    ["--foreground", "var(--ink)"],
    ["--primary", "var(--thread-deep)"],
    ["--ring", "var(--ink)"],
    ["--border", "var(--hairline)"],
    ["--sidebar", "var(--surface)"],
    ["--destructive", "var(--error)"],
  ])("maps shadcn %s to the Alto token %s", (name, value) => {
    expect(css).toContain(`${name}:${value};`);
  });

  it("keeps Alto values and the dark canvas", () => {
    expect(css).toContain("--surface:#f7f7f7;");
    expect(css).toContain("--ink:#222222;");
    expect(css).toContain("--canvas:#121212;");
    expect(css).not.toMatch(/oklch\(/);
  });

  it("uses Jost on body", () => {
    expect(css).toContain("body{font-family:Jost,'AppleSDGothicNeo',system-ui;background:var(--surface);color:var(--ink);}");
  });
});
