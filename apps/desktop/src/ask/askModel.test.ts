import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModel, modelLabel, saveModel } from "./askModel";

describe("askModel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("labels Default, the claude aliases, and anything else as is", () => {
    expect([null, "opus", "sonnet", "haiku", "gpt-6-sol"].map(modelLabel)).toEqual(["Default", "Opus", "Sonnet", "Haiku", "gpt-6-sol"]);
  });

  it("saves per agent; Default clears; a stored model not offered is ignored", () => {
    saveModel("codex", "gpt-6-sol");
    expect(loadModel("codex", ["gpt-6-sol"])).toBe("gpt-6-sol");
    expect(loadModel("codex", ["gpt-6-luna"])).toBeNull();
    expect(loadModel("claude-code", ["gpt-6-sol"])).toBeNull();
    saveModel("codex", null);
    expect(loadModel("codex", ["gpt-6-sol"])).toBeNull();
  });

  it("a throwing storage reads as Default and saving does nothing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadModel("codex", ["gpt-6-sol"])).toBeNull();
    expect(() => saveModel("codex", "gpt-6-sol")).not.toThrow();
  });
});
