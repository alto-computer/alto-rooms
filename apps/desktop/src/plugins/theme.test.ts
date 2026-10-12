import { THEME_TOKENS } from "@alto-rooms/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { readTheme, THEME_SOURCES, watchTheme } from "./theme";

/** The app's token sheet, as far as these tests need it: a light and a dark value for a few, and none for --font-serif. */
function sheet() {
  const style = document.createElement("style");
  style.textContent = `
    :root { --pane: #f8f4ee; --sheet: #fffdf9; --ink: #27211e; --thread-deep: #e31c5f; --radius: 0.5rem; --elev-sheet: 0 1px 1px #462d140d; }
    .dark { --pane: #211c19; --sheet: #2a2420; --ink: #efe7df; --thread-deep: #ff7088; }
  `;
  document.head.append(style);
  return style;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.documentElement.className = "";
  document.querySelectorAll("style").forEach((s) => s.remove());
});

describe("readTheme", () => {
  it("names the sheet's values for the plugin, follows .dark, and leaves out a token the sheet lacks", () => {
    sheet();
    expect(readTheme()).toEqual({
      scheme: "light",
      tokens: { bg: "#f8f4ee", card: "#fffdf9", text: "#27211e", accent: "#e31c5f", radius: "0.5rem", shadow: "0 1px 1px #462d140d" },
    });
    document.documentElement.classList.add("dark");
    expect(readTheme()).toMatchObject({ scheme: "dark", tokens: { bg: "#211c19", text: "#efe7df", accent: "#ff7088" } });
    expect(readTheme().tokens).not.toHaveProperty("font-serif");
  });

  it("sends only names the SDK applies", () => {
    for (const name of Object.keys(THEME_SOURCES)) expect(THEME_TOKENS).toContain(name);
  });
});

describe("watchTheme", () => {
  it("reports a class change that changes the theme, once, and not one that does not", async () => {
    sheet();
    const seen: string[] = [];
    const stop = watchTheme((t) => seen.push(`${t.scheme}:${t.tokens.bg}`));
    document.documentElement.classList.add("dark");
    await flush();
    document.documentElement.classList.add("something-else");
    await flush();
    document.documentElement.classList.remove("dark");
    await flush();
    stop();
    document.documentElement.classList.add("dark");
    await flush();
    expect(seen).toEqual(["dark:#211c19", "light:#f8f4ee"]);
  });
});
